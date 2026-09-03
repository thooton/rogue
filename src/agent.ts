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
import { initializeBundledProviderRuntime } from "./provider-runtime.js";
import { createAutomaticContextCompactor } from "./context-compaction.js";

export interface RogueAgentOptions {
  provider?: string;
  model?: string;
  stateDirectory?: string;
  thinkingLevel?: ThinkingLevel;
  /** When false, the selected route is pinned and configured fallbacks are ignored. */
  allowFailover?: boolean;
  onFailover?: (notice: ModelFailoverNotice) => void;
}

export async function createRogueAgent(options: RogueAgentOptions = {}): Promise<{
  agent: Agent;
  store: RogueStore;
  profile: AgentProfile;
  config: RogueConfigStore;
  contextCompactor: ReturnType<typeof createAutomaticContextCompactor>;
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
  const contextCompactor = createAutomaticContextCompactor({ models, getModel: () => model, thinkingLevel });
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
      onFailover: options.onFailover,
    }),
    convertToLlm,
    transformContext: contextCompactor.transform,
    toolExecution: "parallel",
    sessionId: `rogue-${profile.id}-${crypto.randomUUID()}`,
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

  return { agent, store, profile, config, contextCompactor, provider, model: modelId, systemPrompt };
}
