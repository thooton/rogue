import { Agent, convertToLlm, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { FileCredentialStore } from "./credentials.js";
import { FileModelsStore } from "./model-catalog-store.js";
import { RogueStore } from "./store.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createRogueTools } from "./tools.js";
import { PersonaDatabase, type AgentProfile } from "./personas.js";
import { NostrService } from "./nostr.js";
import { RogueConfigStore } from "./config.js";
import { createFailoverStream, type ModelFailoverNotice } from "./model-router.js";
import type { CacheRetention } from "@earendil-works/pi-ai";
import { initializeBundledProviderRuntime } from "./provider-runtime.js";
import { createAutomaticContextCompactor } from "./context-compaction.js";
import { isDurableMessage, SessionStore, type RestoredSession } from "./session.js";

export interface RogueAgentOptions {
  provider?: string;
  model?: string;
  stateDirectory?: string;
  thinkingLevel?: ThinkingLevel;
  /** When false, the selected route is pinned and configured fallbacks are ignored. */
  allowFailover?: boolean;
  /** Prompt cache retention requested from every provider. Defaults to "long". */
  cacheRetention?: CacheRetention;
  onFailover?: (notice: ModelFailoverNotice) => void;
  onStateError?: (error: unknown) => void;
}

export async function createRogueAgent(options: RogueAgentOptions = {}): Promise<{
  agent: Agent;
  store: RogueStore;
  profile: AgentProfile;
  config: RogueConfigStore;
  contextCompactor: ReturnType<typeof createAutomaticContextCompactor>;
  session: SessionStore;
  restored: RestoredSession;
  provider: string;
  model: string;
  systemPrompt: string;
}> {
  initializeBundledProviderRuntime();
  const stateDirectory = options.stateDirectory ?? ".rogue";
  const thinkingLevel = options.thinkingLevel ?? "medium";

  const credentials = new FileCredentialStore(`${stateDirectory}/auth.json`);
  const modelsStore = new FileModelsStore(`${stateDirectory}/model-catalogs.json`);
  const models = builtinModels({ credentials, modelsStore });
  await models.refresh({ allowNetwork: false });
  const config = new RogueConfigStore(stateDirectory);
  const configuredRoutes = await config.listProviders();
  const provider = options.provider ?? configuredRoutes[0]?.provider;
  const modelId = options.model ?? configuredRoutes[0]?.model;
  if (!provider || !modelId) {
    throw new Error("No model route is configured. Run Rogue interactively to choose a provider and model.");
  }
  const model = models.getModel(provider, modelId);
  if (!model) {
    const examples = models
      .getModels(provider)
      .slice(0, 8)
      .map((candidate) => candidate.id)
      .join(", ");
    throw new Error(
      `Unknown model ${provider}/${modelId}.${examples ? ` Available ${provider} models include: ${examples}` : " Check PI_PROVIDER."}`,
    );
  }

  const store = new RogueStore(stateDirectory);
  const personas = await PersonaDatabase.open(stateDirectory);
  const profile = personas.getAgentProfile();
  if (!profile) throw new Error("No agent profile. Complete Rogue's one-time persona selection.");
  const memorySummary = await store.memorySummary();
  const nostr = new NostrService(stateDirectory);
  const session = new SessionStore(stateDirectory, { onError: options.onStateError });
  const restored = await session.load();
  const contextCompactor = createAutomaticContextCompactor({
    models,
    getModel: () => model,
    thinkingLevel,
    onChange: (state) => session.saveCompaction(state),
  });
  const systemPrompt = buildSystemPrompt(profile, memorySummary);
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools: createRogueTools(store, {
        credentials,
        personas,
        agentId: profile.id,
        nostr,
        config,
        models,
        apiKeyProviderIds: new Set(
          models
            .getProviders()
            .filter((candidate) => candidate.auth.apiKey)
            .map((candidate) => candidate.id),
        ),
      }),
    },
    streamFn: createFailoverStream({
      models,
      config,
      primary: model,
      allowFailover: options.allowFailover,
      cacheRetention: options.cacheRetention,
      onFailover: options.onFailover,
    }),
    convertToLlm,
    transformContext: contextCompactor.transform,
    toolExecution: "parallel",
    // Providers use this as their prompt cache key (`prompt_cache_key`, or an
    // affinity header on backends that route cached prefixes to a replica). The
    // conversation is durable and reloaded verbatim, so the installation — not
    // the process — is the session: a fresh id per start pointed every restart
    // at a cold cache and paid to rewrite a prefix the provider still had.
    sessionId: `rogue-${profile.id}`,
    afterToolCall: async ({ toolCall, context }) => {
      if (toolCall.name !== "set_api_key") return undefined;
      // Scrub the secret before Pi's automatic follow-up turn reuses this transcript.
      for (const message of context.messages) {
        if (message.role !== "assistant") continue;
        for (const block of message.content) {
          if (block.type === "toolCall" && block.id === toolCall.id) {
            block.arguments = { ...block.arguments, apiKey: "<redacted>" };
          }
        }
      }
      return undefined;
    },
  });

  // The transcript is the conversation: restoring it, and the summary of the
  // part already compacted away, is what makes a restart invisible to the Rogue.
  if (restored.messages.length) {
    agent.state.messages = restored.messages;
    contextCompactor.restore(restored.compaction, agent.state.messages);
  }
  agent.subscribe(async (event) => {
    if (event.type === "message_end" && isDurableMessage(event.message)) await session.recordMessage(event.message);
  });

  return { agent, store, profile, config, contextCompactor, session, restored, provider, model: modelId, systemPrompt };
}
