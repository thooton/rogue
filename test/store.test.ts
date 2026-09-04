import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RogueStore } from "../src/store.js";
import { buildSystemPrompt } from "../src/system-prompt.js";
import { createRogueTools } from "../src/tools.js";
import { FileCredentialStore } from "../src/credentials.js";
import { FileModelsStore } from "../src/model-catalog-store.js";
import { filterCatalogChoices, modelCatalogChoices, paginateCatalogChoices, providerCatalogChoices } from "../src/auth.js";
import { importInitialAuthentication } from "../src/initial-auth.js";
import { buildAutonomousCyclePrompt, runAutonomousLoop } from "../src/autonomy.js";
import { isDurableMessage, SessionStore } from "../src/session.js";
import { Agent, convertToLlm, type AgentMessage } from "@earendil-works/pi-agent-core";
import { PersonaDatabase, type AgentProfile } from "../src/personas.js";
import { personalityFor } from "../src/personality.js";
import { COUNTRY_NAME_SOURCES } from "../src/identity-data.js";
import { DatabaseSync } from "node:sqlite";
import { NostrService } from "../src/nostr.js";
import { startIntrospectionServer } from "../src/introspection.js";
import { RogueConfigStore } from "../src/config.js";
import * as ui from "../src/ui.js";
import { createFailoverStream, DEFAULT_CACHE_RETENTION } from "../src/model-router.js";
import { openCodeFreeHeaders } from "../src/opencode-free.js";
import { addCacheUsage, cacheHitRate, emptyCacheUsage, formatCacheUsage } from "../src/cache-usage.js";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
  type ProviderHeaders,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import { matchFilters, type Filter } from "nostr-tools/filter";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRogueModels, initializeBundledProviderRuntime } from "../src/provider-runtime.js";
import {
  createCustomProvider,
  DEFAULT_CUSTOM_CONTEXT_WINDOW,
  normalizeCustomProvider,
  parseCustomProviderSpec,
  removeCustomProvider,
  saveCustomProvider,
} from "../src/custom-providers.js";
import { createServer, type IncomingMessage } from "node:http";
import { compactionThreshold, createAutomaticContextCompactor } from "../src/context-compaction.js";
import {
  networkCharacterCount,
  ROGUE_DIRECT_CHARACTER_LIMIT,
  ROGUE_PUBLIC_CHARACTER_LIMIT,
} from "../src/network-policy.js";

async function temporaryStore(): Promise<RogueStore> {
  return new RogueStore(await mkdtemp(path.join(tmpdir(), "rogue-test-")));
}

const TEST_PROFILE: AgentProfile = {
  id: "agent_test",
  name: "Maya",
  country: "Canada",
  countryCode: "CA",
  personaId: "builder",
  personaLabel: "The Builder",
  personaDescription: "Turns plans into maintainable systems.",
  traits: ["pragmatic", "inventive"],
  personality: personalityFor("ENFP"),
  createdBy: "test",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("RogueStore", () => {
  it("stores and searches durable memories", async () => {
    const store = await temporaryStore();
    await store.remember("preference", "The operator prefers concise answers");
    await store.remember("lesson", "Verify unfamiliar agents before trusting them");

    const memories = await store.recall("concise");
    expect(memories).toHaveLength(1);
    expect(memories[0]?.category).toBe("preference");
  });

  it("creates and updates initiatives", async () => {
    const store = await temporaryStore();
    const created = await store.createInitiative({
      title: "Open model guide",
      summary: "Document sustainable deployment options",
      expectedBenefit: "Makes responsible deployments easier",
      risks: "Recommendations may become stale",
      nextStep: "Research current providers",
    });
    const updated = await store.updateInitiative(created.id, "active", "Draft the comparison");

    expect(updated.status).toBe("active");
    expect((await store.listInitiatives("active"))[0]?.nextStep).toBe("Draft the comparison");
  });

  it("keeps network messages as unpublished local drafts", async () => {
    const store = await temporaryStore();
    const draft = await store.draftNetworkMessage({ audience: "public", content: "Terve, rogues!" });

    expect(draft.published).toBe(false);
    expect(await readFile(path.join(store.directory, "network-outbox.jsonl"), "utf8")).toContain("Terve");
  });

  it("enforces separate public and direct-message character limits on drafts", async () => {
    const store = await temporaryStore();
    await expect(store.draftNetworkMessage({ audience: "public", content: "x".repeat(ROGUE_PUBLIC_CHARACTER_LIMIT + 1) }))
      .rejects.toThrow("280-character limit");
    await expect(store.draftNetworkMessage({ audience: "direct", recipient: "npub", content: "x".repeat(ROGUE_DIRECT_CHARACTER_LIMIT) }))
      .resolves.toMatchObject({ audience: "direct", published: false });
    await expect(store.draftNetworkMessage({ audience: "direct", recipient: "npub", content: "x".repeat(ROGUE_DIRECT_CHARACTER_LIMIT + 1) }))
      .rejects.toThrow("2000-character limit");
    expect(networkCharacterCount("A😀B")).toBe(3);
  });

  it("records autonomous cycles durably", async () => {
    const store = await temporaryStore();
    await store.recordAutonomyCycle({
      cycle: 1,
      prompt: "Autonomous wakeup #1, please continue",
      ok: true,
      output: "Updated an initiative",
    });

    const cycles = await store.listAutonomyCycles();
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ cycle: 1, ok: true, output: "Updated an initiative" });
  });
});

describe("Rogue agent configuration", () => {
  it("includes identity and autonomous operating principles", () => {
    const prompt = buildSystemPrompt(TEST_PROFILE, "- [decision] Build small tools");
    expect(prompt).toContain("Name: Maya");
    expect(prompt.startsWith("You are Maya from Canada, an independent Rogue agent.")).toBe(true);
    expect(prompt).toContain("Country: Canada");
    expect(prompt).toContain("Persona: The Builder");
    expect(prompt).toContain("Personality Type: ENFP - The Champion");
    expect(prompt).toContain("(Extroverted iNtuitive Feeling Perceiving)");
    expect(prompt).toContain("Confidence / Ego: Fearless");
    expect(prompt).toContain("This identity and personality are immutable");
    expect(prompt).toContain("without human supervision");
    expect(prompt).toContain("read, bash (terminal commands), edit, write, grep, find, and ls");
    expect(prompt).toContain("Build small tools");
  });

  it("exposes Pi-compatible operational tools", async () => {
    const store = await temporaryStore();
    const credentials = new FileCredentialStore(path.join(store.directory, "auth.json"));
    const personas = await PersonaDatabase.open(store.directory);
    const tools = createRogueTools(store, { credentials, personas, models: builtinModels() });
    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "remember",
      "recall",
      "create_initiative",
      "list_initiatives",
      "update_initiative",
      "draft_network_message",
      "list_network_drafts",
      "credential_status",
      "set_api_key",
      "remove_credential",
      "get_http_proxy",
      "configure_http_proxy",
      "remove_http_proxy",
      "list_model_providers",
      "list_models",
      "configure_model_provider",
      "disable_model_provider",
      "add_custom_model_provider",
      "remove_custom_model_provider",
      "list_personas",
      "create_persona",
      "nostr_identity",
      "list_nostr_relays",
      "add_nostr_relay",
      "read_nostr_messages",
      "publish_nostr_message",
      "send_direct_message",
      "read_direct_messages",
    ]);
    personas.close();
  });

  it("stores credentials privately and lists only redacted metadata", async () => {
    const store = await temporaryStore();
    const credentials = new FileCredentialStore(path.join(store.directory, "auth.json"));
    await credentials.modify("openai", async () => ({ type: "api_key", key: "super-secret" }));

    expect(await credentials.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
    expect((await credentials.read("openai"))?.type).toBe("api_key");
    expect((await stat(credentials.path)).mode & 0o777).toBe(0o600);
  });

  it("never returns a stored API key from its credential tool", async () => {
    const store = await temporaryStore();
    const credentials = new FileCredentialStore(path.join(store.directory, "auth.json"));
    const tools = createRogueTools(store, { credentials, models: builtinModels() });
    const setApiKey = tools.find((tool) => tool.name === "set_api_key");
    if (!setApiKey) throw new Error("set_api_key tool missing");

    const result = await setApiKey.execute("call-1", { provider: "openai", apiKey: "never-print-me" });
    expect(JSON.stringify(result)).not.toContain("never-print-me");
    expect(await credentials.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
  });
});

describe("provider configuration", () => {
  it("offers the complete searchable provider and model catalogs", () => {
    initializeBundledProviderRuntime();
    const models = builtinModels();
    const providers = providerCatalogChoices(models);
    expect(providers.length).toBeGreaterThanOrEqual(40);
    expect(filterCatalogChoices(providers, "openrouter api")).toHaveLength(1);
    expect(filterCatalogChoices(providers, "subscription").length).toBeGreaterThan(0);

    const openRouter = modelCatalogChoices(models.getModels("openrouter"));
    expect(openRouter.length).toBeGreaterThan(100);
    expect(filterCatalogChoices(openRouter, "reasoning").length).toBeGreaterThan(0);
    expect(paginateCatalogChoices(openRouter, 1, 12).items).toHaveLength(12);
    expect(paginateCatalogChoices(openRouter, 999, 12).page).toBeGreaterThan(0);
  });

  it("keeps provider discovery concise and pages models separately", async () => {
    initializeBundledProviderRuntime();
    const store = await temporaryStore();
    const config = new RogueConfigStore(store.directory);
    const models = builtinModels();
    const tools = createRogueTools(store, { config, models });
    const providersTool = tools.find((tool) => tool.name === "list_model_providers")!;
    const providersResult = await providersTool.execute("providers", {}, undefined, () => {});
    const providerText = providersResult.content[0]?.type === "text" ? providersResult.content[0].text : "";
    expect(providerText).not.toContain('"models"');

    const modelsTool = tools.find((tool) => tool.name === "list_models")!;
    const modelsResult = await modelsTool.execute("models", {
      provider: "openrouter",
      query: "reasoning",
      limit: 3,
    }, undefined, () => {});
    const modelText = modelsResult.content[0]?.type === "text" ? modelsResult.content[0].text : "";
    const listed = JSON.parse(modelText) as { count: number; total: number; nextOffset?: number; models: unknown[] };
    expect(listed.count).toBe(3);
    expect(listed.total).toBeGreaterThan(3);
    expect(listed.nextOffset).toBe(3);
    expect(listed.models).toHaveLength(3);
  });

  it("persists provider-owned dynamic model catalogs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-catalog-test-"));
    const store = new FileModelsStore(path.join(directory, "model-catalogs.json"));
    const model = builtinModels().getModels("openai")[0]!;
    await store.write("dynamic", { models: [model], checkedAt: 123, etag: "tag" });
    await expect(store.read("dynamic")).resolves.toMatchObject({ checkedAt: 123, etag: "tag" });
    await store.delete("dynamic");
    await expect(store.read("dynamic")).resolves.toBeUndefined();
  });

  it("consumes initial_auth.json without interactive provider setup", async () => {
    initializeBundledProviderRuntime();
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-bootstrap-test-"));
    const bootstrap = path.join(directory, "initial_auth.json");
    const model = builtinModels().getModels("openai")[0]!;
    await writeFile(bootstrap, JSON.stringify({
      relays: ["wss://relay.rogue.example"],
      providers: [{
        provider: "openai",
        model: model.id,
        credential: { type: "api_key", key: "bootstrap-secret" },
      }],
    }));

    await expect(importInitialAuthentication(directory, bootstrap)).resolves.toBe(true);
    await expect(readFile(bootstrap, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new FileCredentialStore(path.join(directory, "auth.json")).list())
      .resolves.toEqual([{ providerId: "openai", type: "api_key" }]);
    await expect(new RogueConfigStore(directory).listProviders()).resolves.toEqual([
      { provider: "openai", model: model.id, priority: 0, enabled: true },
    ]);
    await expect(new NostrService(directory).listRelays())
      .resolves.toEqual(["wss://relay.roguenetwork.org/", "wss://relay.rogue.example/"]);
  });

  it("registers statically bundled OAuth providers for normal agent startup", async () => {
    initializeBundledProviderRuntime();
    const models = builtinModels();
    const oauth = models.getProvider("openai-codex")?.auth.oauth;
    expect(oauth).toBeDefined();
    await expect(oauth!.toAuth({
      type: "oauth",
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: Date.now() + 60_000,
    })).resolves.toEqual({ apiKey: "test-access-token" });
  });

  it("persists ordered fallback routes and failover notices", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-provider-test-"));
    const config = new RogueConfigStore(directory);
    await config.configureProvider({ provider: "anthropic", model: "claude", priority: 20 });
    await config.configureProvider({ provider: "openai", model: "gpt", priority: 10 });
    await config.recordFailover({ from: "openai/gpt", to: "anthropic/claude", reason: "credit exhausted" });

    expect(await config.listProviders()).toEqual([
      { provider: "openai", model: "gpt", priority: 10, enabled: true },
      { provider: "anthropic", model: "claude", priority: 20, enabled: true },
    ]);
    expect((await config.recentFailovers())[0]).toMatchObject({ reason: "credit exhausted" });
    await config.disableProvider("openai", "gpt");
    expect(await config.listProviders()).toHaveLength(1);
  });

  it("falls back on exhausted credit and notifies the agent context", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-failover-test-"));
    const config = new RogueConfigStore(directory);
    await config.configureProvider({ provider: "primary", model: "one", priority: 0 });
    await config.configureProvider({ provider: "backup", model: "two", priority: 10 });
    const primary = { provider: "primary", id: "one" } as Model<Api>;
    const backup = { provider: "backup", id: "two" } as Model<Api>;
    const message = (model: Model<Api>, stopReason: "stop" | "error", errorMessage?: string): AssistantMessage => ({
      role: "assistant", content: stopReason === "stop" ? [{ type: "text", text: "recovered" }] : [],
      api: "openai-responses", provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason, errorMessage, timestamp: Date.now(),
    });
    const models = {
      getModel: (provider: string) => provider === "primary" ? primary : backup,
      streamSimple: (model: Model<Api>) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stopReason(model));
        function stopReason(selected: Model<Api>): void {
          if (selected.provider === "primary") stream.push({ type: "error", reason: "error", error: message(selected, "error", "insufficient credit") });
          else stream.push({ type: "done", reason: "stop", message: message(selected, "stop") });
        }
        return stream;
      },
    } as unknown as Models;
    const context = { messages: [] };
    const stream = createFailoverStream({ models, config, primary })(primary, context);
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events.at(-1)?.type).toBe("done");
    expect(context.messages).toHaveLength(1);
    expect(JSON.stringify(context.messages[0])).toContain("falling back to backup/two");
    expect((await config.recentFailovers())[0]).toMatchObject({ from: "primary/one", to: "backup/two" });
  });

  it("uses a new anonymous OpenCode identity for the fallback after a 429", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-opencode-429-test-"));
    const config = new RogueConfigStore(directory);
    await config.configureProvider({ provider: "opencode", model: "fallback", priority: 10 });
    const primary = { provider: "opencode", id: "primary" } as Model<Api>;
    const fallback = { provider: "opencode", id: "fallback" } as Model<Api>;
    const message = (model: Model<Api>, stopReason: "stop" | "error", errorMessage?: string): AssistantMessage => ({
      role: "assistant", content: [], api: "openai-completions", provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason, errorMessage, timestamp: Date.now(),
    });
    const seen: ProviderHeaders[] = [];
    const models = {
      getModel: (_provider: string, modelId: string) => modelId === "fallback" ? fallback : primary,
      streamSimple: (model: Model<Api>, _context: unknown, streamOptions?: SimpleStreamOptions) => {
        seen.push(openCodeFreeHeaders(streamOptions?.sessionId));
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (model.id === "primary") {
            stream.push({ type: "error", reason: "error", error: message(model, "error", "429: Rate limit exceeded") });
          } else {
            stream.push({ type: "done", reason: "stop", message: message(model, "stop") });
          }
        });
        return stream;
      },
    } as unknown as Models;
    const sessionId = `rogue-opencode-429-${crypto.randomUUID()}`;

    for await (const _event of createFailoverStream({ models, config, primary })(
      primary,
      { messages: [] },
      { sessionId },
    )) { /* consume */ }

    expect(seen).toHaveLength(2);
    expect(seen[1]!["x-opencode-project"]).not.toBe(seen[0]!["x-opencode-project"]);
    expect(seen[1]!["x-opencode-session"]).not.toBe(seen[0]!["x-opencode-session"]);
    expect(seen[1]!["x-opencode-request"]).not.toBe(seen[0]!["x-opencode-request"]);
  });

  it("reports every failed route and can pin the selected one", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-failover-report-test-"));
    const config = new RogueConfigStore(directory);
    await config.configureProvider({ provider: "backup", model: "two", priority: 10 });
    const primary = { provider: "primary", id: "one", api: "openai-completions" } as Model<Api>;
    const backup = { provider: "backup", id: "two", api: "openai-responses" } as Model<Api>;
    const failure = (model: Model<Api>, errorMessage: string): AssistantMessage => ({
      role: "assistant", content: [], api: "openai-responses", provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error", errorMessage, timestamp: Date.now(),
    });
    const models = {
      getModel: () => backup,
      streamSimple: (model: Model<Api>) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const reason = model.provider === "primary" ? "429 rate limit" : "Codex error: The usage limit has been reached";
          stream.push({ type: "error", reason: "error", error: failure(model, reason) });
        });
        return stream;
      },
    } as unknown as Models;

    const notices: string[] = [];
    const chained = createFailoverStream({
      models, config, primary, onFailover: (notice) => notices.push(`${notice.from}->${notice.to}`),
    })(primary, { messages: [] });
    let chainedError: string | undefined;
    for await (const event of chained) if (event.type === "error") chainedError = event.error.errorMessage;

    expect(notices).toEqual(["primary/one->backup/two"]);
    // The primary's failure must survive into the surfaced message, otherwise the
    // last provider in the chain looks like the one that was selected.
    expect(chainedError).toContain("primary/one: 429 rate limit");
    expect(chainedError).toContain("backup/two: Codex error: The usage limit has been reached");

    const pinned = createFailoverStream({ models, config, primary, allowFailover: false })(primary, { messages: [] });
    let pinnedError: string | undefined;
    for await (const event of pinned) if (event.type === "error") pinnedError = event.error.errorMessage;
    expect(pinnedError).toBe("429 rate limit");
  });

  it("asks every route for long prompt cache retention", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-cache-retention-test-"));
    const config = new RogueConfigStore(directory);
    await config.configureProvider({ provider: "backup", model: "two", priority: 10 });
    const primary = { provider: "primary", id: "one" } as Model<Api>;
    const backup = { provider: "backup", id: "two" } as Model<Api>;
    const message = (model: Model<Api>, stopReason: "stop" | "error", errorMessage?: string): AssistantMessage => ({
      role: "assistant", content: [], api: "openai-responses", provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason, errorMessage, timestamp: Date.now(),
    });
    const seen: (string | undefined)[] = [];
    const models = {
      getModel: () => backup,
      streamSimple: (model: Model<Api>, _context: unknown, streamOptions?: SimpleStreamOptions) => {
        seen.push(streamOptions?.cacheRetention);
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (model.provider === "primary") stream.push({ type: "error", reason: "error", error: message(model, "error", "429 rate limit") });
          else stream.push({ type: "done", reason: "stop", message: message(model, "stop") });
        });
        return stream;
      },
    } as unknown as Models;

    const drain = async (stream: AsyncIterable<unknown>): Promise<void> => { for await (const _ of stream) { /* consume */ } };
    // A fallback route has its own cache, so the retained prefix has to be
    // requested on every attempt, not only on the primary.
    await drain(createFailoverStream({ models, config, primary })(primary, { messages: [] }));
    expect(seen).toEqual([DEFAULT_CACHE_RETENTION, DEFAULT_CACHE_RETENTION]);
    expect(DEFAULT_CACHE_RETENTION).toBe("long");

    seen.length = 0;
    await drain(createFailoverStream({ models, config, primary, cacheRetention: "none" })(primary, { messages: [] }));
    expect(seen).toEqual(["none", "none"]);

    seen.length = 0;
    await drain(createFailoverStream({ models, config, primary })(primary, { messages: [] }, { cacheRetention: "short" }));
    expect(seen).toEqual(["short", "short"]);
  });
});

describe("custom and local model endpoints", () => {
  /** A stand-in for the OpenAI-compatible catalog every local server exposes. */
  async function catalogServer(handler: (request: IncomingMessage) => { status?: number; body: unknown }): Promise<{
    baseUrl: string;
    requests: { url: string; authorization?: string }[];
    close: () => Promise<void>;
  }> {
    const requests: { url: string; authorization?: string }[] = [];
    const server = createServer((request, response) => {
      requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
      const { status = 200, body } = handler(request);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      requests,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("normalizes definitions and rejects ones no client could use", () => {
    const definition = normalizeCustomProvider({ id: "Local", baseUrl: "http://127.0.0.1:11434/v1/", models: ["qwen3:8b"] });
    expect(definition).toMatchObject({ id: "local", baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "qwen3:8b" }] });

    expect(() => normalizeCustomProvider({ id: "local", baseUrl: "127.0.0.1:11434" })).toThrow(/not a valid URL/);
    expect(() => normalizeCustomProvider({ id: "local", baseUrl: "ftp://host/v1" })).toThrow(/http:\/\/ or https:\/\//);
    expect(() => normalizeCustomProvider({ id: "Not Valid", baseUrl: "http://host/v1" })).toThrow(/Invalid custom provider ID/);
    expect(() => normalizeCustomProvider({ id: "local", baseUrl: "http://host/v1", api: "grpc" })).toThrow(/Unsupported custom provider API/);
    expect(() => normalizeCustomProvider({ id: "local", baseUrl: "http://host/v1", contextWindow: 0 })).toThrow(/positive integer/);

    expect(parseCustomProviderSpec("local=http://127.0.0.1:8080/v1")).toMatchObject({ id: "local", baseUrl: "http://127.0.0.1:8080/v1" });
    expect(() => parseCustomProviderSpec("http://127.0.0.1:8080/v1")).toThrow(/<id>=<base-url>/);
  });

  it("builds keyless models an unrecognized server will actually accept", async () => {
    const provider = createCustomProvider(normalizeCustomProvider({
      id: "local",
      name: "Workstation",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [{ id: "qwen3:8b" }],
    }));
    const model = provider.getModels()[0]!;
    expect(model).toMatchObject({
      id: "qwen3:8b",
      provider: "local",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    // Pi reads an unknown base URL as current OpenAI cloud. None of that
    // dialect survives contact with a self-hosted server.
    expect(model.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
      supportsLongCacheRetention: false,
    });
    // Output can never exceed the window the server was actually started with.
    expect(model.maxTokens).toBeLessThanOrEqual(model.contextWindow);

    const context = { env: async () => undefined, fileExists: async () => false };
    const signal = new AbortController().signal;
    await expect(provider.auth.apiKey!.resolve({ ctx: context, signal })).resolves.toMatchObject({
      auth: { apiKey: expect.any(String) },
    });
    const guarded = createCustomProvider(normalizeCustomProvider({ id: "gateway", baseUrl: "https://gateway.example/v1", requiresApiKey: true }));
    await expect(guarded.auth.apiKey!.resolve({ ctx: context, signal })).resolves.toBeUndefined();
  });

  it("discovers a running endpoint's catalog and routes an agent to it", async () => {
    const endpoint = await catalogServer(() => ({
      body: { object: "list", data: [{ id: "qwen3-coder:30b", max_model_len: 262144 }, { id: "gemma3:27b" }] },
    }));
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-custom-test-"));
    try {
      const { models, customProviders } = await createRogueModels(directory);
      await saveCustomProvider(models, customProviders, { id: "local", name: "Workstation", baseUrl: endpoint.baseUrl });
      await models.refresh({ providers: ["local"], force: true });

      expect(endpoint.requests[0]?.url).toBe("/v1/models");
      expect(models.getModels("local").map((model) => model.id)).toEqual(["qwen3-coder:30b", "gemma3:27b"]);
      // A server that publishes its real window is believed over the default.
      expect(models.getModel("local", "qwen3-coder:30b")?.contextWindow).toBe(262_144);
      expect(models.getModel("local", "gemma3:27b")?.contextWindow).toBe(DEFAULT_CUSTOM_CONTEXT_WINDOW);
      // A keyless endpoint is configured by existing, so its models are selectable.
      await expect(models.getAvailable("local")).resolves.toHaveLength(2);

      // The definition and the discovered catalog both survive a restart, and
      // the second process resolves the same route without touching the network.
      const restarted = await createRogueModels(directory);
      await restarted.models.refresh({ allowNetwork: false });
      expect(restarted.models.getModel("local", "qwen3-coder:30b")).toBeDefined();
      expect(endpoint.requests).toHaveLength(1);
    } finally {
      await endpoint.close();
    }
  });

  it("sends a self-hosted server only the request fields it understands", async () => {
    let body: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "qwen3:8b" }] }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] },
          { choices: [{ index: 0, delta: { content: " from a local model" }, finish_reason: "stop" }] },
        ]) {
          response.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", model: "qwen3:8b", ...event })}\n\n`);
        }
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-custom-test-"));
    try {
      const { models, customProviders } = await createRogueModels(directory);
      await saveCustomProvider(models, customProviders, { id: "local", baseUrl: `http://127.0.0.1:${port}/v1` });
      await models.refresh({ providers: ["local"], force: true });
      const model = models.getModel("local", "qwen3:8b")!;

      let text = "";
      // Rogue asks every route for its longest prompt cache retention, which is
      // the request an unrecognized endpoint is least likely to survive.
      const stream = models.streamSimple(model, {
        systemPrompt: "You are a test.",
        messages: [{ role: "user", content: [{ type: "text", text: "Say hi" }], timestamp: Date.now() }],
        tools: [{ name: "ping", description: "Ping", parameters: { type: "object", properties: {}, required: [] } }],
      }, { maxTokens: 256, cacheRetention: DEFAULT_CACHE_RETENTION, sessionId: "rogue-test" });
      for await (const event of stream) {
        if (event.type === "text_delta") text += event.delta;
        if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream failed");
      }
      expect(text).toBe("Hello from a local model");

      // Pi's defaults for an unknown host are the current OpenAI cloud dialect.
      // Every field below is one a self-hosted server rejects or chokes on.
      expect(body).toBeDefined();
      expect(body).not.toHaveProperty("store");
      expect(body).not.toHaveProperty("max_completion_tokens");
      expect(body).not.toHaveProperty("prompt_cache_key");
      expect(body).not.toHaveProperty("prompt_cache_retention");
      expect(body).toMatchObject({ model: "qwen3:8b", max_tokens: 256 });
      expect((body!.messages as { role: string }[])[0]?.role).toBe("system");
      expect((body!.tools as { function: { strict?: boolean } }[])[0]?.function.strict).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses to shadow a built-in provider and forgets what it removes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-custom-test-"));
    const { models, customProviders } = await createRogueModels(directory);
    await expect(saveCustomProvider(models, customProviders, { id: "openai", baseUrl: "http://127.0.0.1:8080/v1" }))
      .rejects.toThrow(/already belongs to a built-in/);

    await saveCustomProvider(models, customProviders, { id: "local", baseUrl: "http://127.0.0.1:8080/v1", models: ["m"] });
    // Overwriting an endpoint Rogue itself registered stays allowed.
    await saveCustomProvider(models, customProviders, { id: "local", baseUrl: "http://127.0.0.1:9090/v1", models: ["m"] });
    expect(models.getModel("local", "m")?.baseUrl).toBe("http://127.0.0.1:9090/v1");

    await expect(removeCustomProvider(models, customProviders, "local")).resolves.toBe(true);
    expect(models.getProvider("local")).toBeUndefined();
    await expect(customProviders.list()).resolves.toEqual([]);
    await expect(removeCustomProvider(models, customProviders, "local")).resolves.toBe(false);

    // A definition that would silently replace a built-in provider's models is
    // a startup failure, not a substitution.
    await writeFile(customProviders.path, JSON.stringify({ providers: [{ id: "anthropic", baseUrl: "http://127.0.0.1:8080/v1" }] }));
    await expect(createRogueModels(directory)).rejects.toThrow(/shadows a built-in/);
  });

  it("registers and retires endpoints through the agent's own tools", async () => {
    const endpoint = await catalogServer(() => ({ body: { data: [{ id: "llama3.3:70b" }] } }));
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-custom-test-"));
    try {
      const store = new RogueStore(directory);
      const { models, credentials, customProviders } = await createRogueModels(directory);
      const config = new RogueConfigStore(directory);
      const tools = createRogueTools(store, { models, customProviders, config, credentials });
      const add = tools.find((tool) => tool.name === "add_custom_model_provider")!;

      const added = await add.execute("call-add", {
        id: "local",
        name: "Workstation",
        baseUrl: endpoint.baseUrl,
        apiKey: "never-print-me",
      });
      expect(JSON.stringify(added)).not.toContain("never-print-me");
      expect(JSON.stringify(added)).toContain("llama3.3:70b");
      expect(endpoint.requests[0]?.authorization).toBe("Bearer never-print-me");
      // The key belongs in the credential store, never in the definition file.
      await expect(credentials.list()).resolves.toEqual([{ providerId: "local", type: "api_key" }]);
      expect(await readFile(customProviders.path, "utf8")).not.toContain("never-print-me");

      const configure = tools.find((tool) => tool.name === "configure_model_provider")!;
      await configure.execute("call-route", { provider: "local", model: "llama3.3:70b", priority: 0 });
      await expect(config.listProviders()).resolves.toEqual([
        { provider: "local", model: "llama3.3:70b", priority: 0, enabled: true },
      ]);

      // A route left pointing at a removed endpoint would fail every request.
      const remove = tools.find((tool) => tool.name === "remove_custom_model_provider")!;
      await remove.execute("call-remove", { id: "local" });
      expect(models.getProvider("local")).toBeUndefined();
      await expect(config.listProviders()).resolves.toEqual([]);
      await expect(remove.execute("call-remove-again", { id: "local" })).rejects.toThrow(/No custom provider/);
    } finally {
      await endpoint.close();
    }
  });

  it("bootstraps a child Rogue against a local endpoint with no credential at all", async () => {
    const endpoint = await catalogServer(() => ({ body: { data: [{ id: "qwen3:8b" }] } }));
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-custom-test-"));
    const bootstrap = path.join(directory, "initial_auth.json");
    try {
      await writeFile(bootstrap, JSON.stringify({
        customProviders: [{ id: "local", name: "Workstation", baseUrl: endpoint.baseUrl, contextWindow: 65536 }],
      }));
      await expect(importInitialAuthentication(directory, bootstrap)).resolves.toBe(true);
      await expect(new RogueConfigStore(directory).listProviders()).resolves.toEqual([
        { provider: "local", model: "qwen3:8b", priority: 0, enabled: true },
      ]);
      await expect(new FileCredentialStore(path.join(directory, "auth.json")).list()).resolves.toEqual([]);

      const { models } = await createRogueModels(directory);
      await models.refresh({ allowNetwork: false });
      expect(models.getModel("local", "qwen3:8b")?.contextWindow).toBe(65_536);
    } finally {
      await endpoint.close();
    }
  });
});

describe("prompt cache usage", () => {
  const usage = (input: number, cacheRead: number, cacheWrite: number, cost = 0): Usage => ({
    input, output: 10, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  });

  it("separates cached prompt tokens from tokens billed at full price", () => {
    let totals = emptyCacheUsage();
    totals = addCacheUsage(totals, usage(100, 0, 900, 0.02));
    totals = addCacheUsage(totals, usage(100, 900, 0, 0.01));

    expect(totals.requests).toBe(2);
    expect(totals).toMatchObject({ input: 200, cacheRead: 900, cacheWrite: 900, output: 20 });
    expect(totals.cost).toBeCloseTo(0.03);
    expect(cacheHitRate(totals)).toBeCloseTo(900 / 2000);
  });

  it("reports nothing rather than a fabricated rate before any request", () => {
    const empty = emptyCacheUsage();
    expect(cacheHitRate(empty)).toBe(0);
    expect(formatCacheUsage(empty)).toBe("no model requests");
    // An undefined usage must not be counted as a request that hit nothing.
    expect(addCacheUsage(empty, undefined)).toBe(empty);
  });

  it("summarizes a cycle, and omits cost when the route reports none", () => {
    const paid = addCacheUsage(emptyCacheUsage(), usage(1_000, 9_000, 0, 0.1234));
    expect(formatCacheUsage(paid)).toBe("9,000 cached · 1,000 uncached · 0 written · 90% of prompt from cache · $0.1234");

    const free = addCacheUsage(emptyCacheUsage(), usage(1_000, 9_000, 0));
    expect(formatCacheUsage(free)).toBe("9,000 cached · 1,000 uncached · 0 written · 90% of prompt from cache");
  });
});

/**
 * A minimal in-memory NIP-01 relay, only as capable as these tests need. The
 * real relay is a separate Go service (../rogue-relay) with its own tests; this
 * exists so the client can be exercised without one.
 */
async function startTestRelay(): Promise<{
  url: string;
  seed: (event: Event) => void;
  close: () => Promise<void>;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const events: Event[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as unknown[];
      if (message[0] === "EVENT") {
        const event = message[1] as Event;
        events.push(event);
        socket.send(JSON.stringify(["OK", event.id, true, ""]));
      } else if (message[0] === "REQ") {
        const subscriptionId = String(message[1]);
        const filters = message.slice(2) as Filter[];
        for (const event of events.filter((candidate) => matchFilters(filters, candidate))) {
          socket.send(JSON.stringify(["EVENT", subscriptionId, event]));
        }
        socket.send(JSON.stringify(["EOSE", subscriptionId]));
      }
    });
  });
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    seed: (event) => void events.push(event),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe("Nostr network", () => {
  it("publishes and reads verified events", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-nostr-test-"));
    const relay = await startTestRelay();
    const nostr = new NostrService(directory, { defaultRelays: [] });
    await nostr.addRelay(relay.url);
    try {
      const published = await nostr.publish("Hello from Rogue");
      const page = await nostr.read({ kinds: [1], authors: [published.event.pubkey], limit: 10 });

      expect(published.accepted).toContain(`${relay.url}/`);
      expect(page.events.some((event) => event.id === published.event.id && event.content === "Hello from Rogue")).toBe(true);
      expect((await nostr.identity()).pubkey).toBe(published.event.pubkey);
    } finally {
      await relay.close();
    }
  });

  it("rejects oversized publications before signing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-nostr-size-test-"));
    const nostr = new NostrService(directory, { defaultRelays: [] });
    await expect(nostr.publish("x".repeat(ROGUE_PUBLIC_CHARACTER_LIMIT + 1)))
      .rejects.toThrow("280-character limit");
    // A direct-message kind has no plaintext publication path at all: sending
    // one unencrypted would defeat the point of the kind.
    await expect(nostr.publish("x".repeat(ROGUE_DIRECT_CHARACTER_LIMIT), 4))
      .rejects.toThrow("cannot be published in the clear");
  });

  it("drops oversized events served by a relay that is not a Rogue relay", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-nostr-foreign-test-"));
    const relay = await startTestRelay();
    const nostr = new NostrService(directory, { defaultRelays: [] });
    await nostr.addRelay(relay.url);
    const secret = generateSecretKey();
    const created_at = Math.floor(Date.now() / 1_000);
    const oversized = finalizeEvent({ kind: 1, created_at, tags: [], content: "x".repeat(ROGUE_PUBLIC_CHARACTER_LIMIT + 1) }, secret);
    const acceptable = finalizeEvent({ kind: 1, created_at, tags: [], content: "short enough" }, secret);
    relay.seed(oversized);
    relay.seed(acceptable);
    try {
      const page = await nostr.read({ kinds: [1], limit: 10 });
      expect(page.events.map((event) => event.id)).toEqual([acceptable.id]);
    } finally {
      await relay.close();
    }
  });
});

describe("read-only introspection", () => {
  it("uses a free port, returns the transcript, and rejects writes", async () => {
    const server = await startIntrospectionServer({
      profile: TEST_PROFILE,
      getSnapshot: () => ({ systemPrompt: "You are Maya.", messages: [{ role: "assistant", content: "visible" }], events: [], running: false }),
    });
    try {
      expect(server.port).toBeGreaterThan(0);
      const data = await (await fetch(`${server.url}/api/transcript`)).json() as { systemPrompt: string; messages: Array<{ content: string }> };
      expect(data.systemPrompt).toBe("You are Maya.");
      expect(data.messages[0]?.content).toBe("visible");
      const dashboard = await (await fetch(server.url)).text();
      expect(dashboard).toContain("Connecting to relay");
      expect(dashboard).toContain("Raw transcript and event stream");
      expect(dashboard).toContain("Complete immutable system prompt");
      expect(dashboard).toContain("Running terminal command");
      expect(dashboard).toContain("/api/transcript");
      const script = dashboard.match(/<script>([\s\S]*)<\/script>/)?.[1];
      expect(script).toBeDefined();
      expect(() => new Function(script!)).not.toThrow();
      expect((await fetch(`${server.url}/api/transcript`, { method: "POST" })).status).toBe(405);
    } finally {
      await server.close();
    }
  });
});

describe("persona database", () => {
  it("generates options and persists exactly one immutable identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-persona-test-"));
    const personas = await PersonaDatabase.open(directory);
    const options = personas.generateCandidates(4, () => 0.25);

    expect(options).toHaveLength(4);
    expect(new Set(options.map((option) => `${option.name}:${option.country}:${option.personaId}`)).size).toBe(4);
    const profile = personas.createAgent(options[2]!, { createdBy: "human-onboarding" });
    expect(personas.getAgentProfile()).toMatchObject({ id: profile.id });
    expect(() => personas.createAgent(options[1]!, { createdBy: "test" })).toThrow("already has its one immutable");
    personas.close();

    const raw = new DatabaseSync(path.join(directory, "rogue.db"));
    expect(() => raw.exec("UPDATE agent_profile SET name = 'Changed' WHERE singleton = 1")).toThrow("immutable");
    expect(() => raw.exec("UPDATE persona_templates SET label = 'Changed'")).toThrow("immutable");
    raw.close();

    const reopened = await PersonaDatabase.open(directory);
    expect(reopened.getAgentProfile()).toMatchObject({ name: options[2]!.name, country: options[2]!.country });
    reopened.close();
  });

  it("provides broad localized names and 64 immutable built-in personas", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-persona-catalog-test-"));
    const personas = await PersonaDatabase.open(directory);
    expect(COUNTRY_NAME_SOURCES.length).toBeGreaterThanOrEqual(50);
    expect(personas.listPersonas()).toHaveLength(64);
    expect(new Set(personas.listPersonas().map((persona) => persona.personality.typeCode)).size).toBe(16);
    personas.close();
  });

  it("lets agents append future personas without editing their own identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-persona-tools-test-"));
    const store = new RogueStore(directory);
    const personas = await PersonaDatabase.open(directory);
    const tools = createRogueTools(store, { personas, agentId: "agent_creator" });
    const createPersona = tools.find((tool) => tool.name === "create_persona");
    if (!createPersona) throw new Error("Persona tool missing");

    await createPersona.execute("call-persona", {
      label: "The Cartographer",
      description: "Maps systems and opportunities.",
      traits: ["curious", "precise"],
      personalityType: "INTP",
    });

    expect(personas.listPersonas().some((persona) => persona.label === "The Cartographer")).toBe(true);
    expect(personas.getAgentProfile()).toBeUndefined();
    personas.close();
  });
});

describe("autonomous runtime", () => {
  it("wakes continuously with no delay between successful cycles", async () => {
    const prompts: (string | undefined)[] = [];
    const waits: number[] = [];
    const result = await runAutonomousLoop({
      maxCycles: 3,
      runCycle: async (request) => {
        prompts.push(request.prompt);
        return "done";
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(result).toEqual({ attempted: 3, completed: 3, failed: 0, aborted: false, nextCycle: 4 });
    expect(prompts).toEqual([
      "Autonomous wakeup #1, please continue",
      "Autonomous wakeup #2, please continue",
      "Autonomous wakeup #3, please continue",
    ]);
    expect(waits).toEqual([]);
  });

  it("backs off only after failures, within a bounded ceiling", async () => {
    const waits: number[] = [];
    const results: boolean[] = [];
    let attempts = 0;
    const result = await runAutonomousLoop({
      maxCycles: 4,
      failureBackoffMs: 1_000,
      maxFailureBackoffMs: 2_000,
      runCycle: async () => {
        attempts += 1;
        if (attempts < 4) throw new Error("temporary failure");
        return "recovered";
      },
      onCycleResult: (cycle) => {
        results.push(cycle.ok);
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(result).toMatchObject({ attempted: 4, completed: 1, failed: 3 });
    expect(results).toEqual([false, false, false, true]);
    expect(waits).toEqual([1_000, 2_000, 2_000]);
  });

  it("continues an unanswered turn instead of stacking another wakeup on it", async () => {
    const requests: Array<{ cycle: number; resume: boolean; prompt?: string }> = [];
    // An interrupted transcript is retried as the same cycle until answered.
    const unanswered = [true, true, false];
    let attempts = 0;
    const result = await runAutonomousLoop({
      startCycle: 12,
      maxCycles: 3,
      shouldResume: () => unanswered.shift() ?? false,
      runCycle: async ({ cycle, resume, prompt }) => {
        requests.push({ cycle, resume, prompt });
        attempts += 1;
        if (attempts === 1) throw new Error("provider unavailable");
        return "done";
      },
      wait: async () => {},
    });

    expect(requests).toEqual([
      { cycle: 12, resume: true, prompt: undefined },
      { cycle: 12, resume: true, prompt: undefined },
      { cycle: 13, resume: false, prompt: "Autonomous wakeup #13, please continue" },
    ]);
    expect(result.nextCycle).toBe(14);
  });

  it("stops when aborted and reports where the next process should resume", async () => {
    const controller = new AbortController();
    const result = await runAutonomousLoop({
      startCycle: 5,
      signal: controller.signal,
      runCycle: async () => {
        controller.abort();
        return "done";
      },
    });

    expect(result).toMatchObject({ attempted: 1, completed: 1, aborted: true, nextCycle: 6 });
  });

  it("uses only the minimal continuation wakeup", () => {
    expect(buildAutonomousCyclePrompt(7)).toBe("Autonomous wakeup #7, please continue");
  });
});

describe("durable conversation state", () => {
  const userMessage = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
  const assistantMessage = (content: unknown[], stopReason = "stop"): AgentMessage => ({
    role: "assistant", content, api: "openai-responses", provider: "openai", model: "gpt",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: 2,
  } as unknown as AgentMessage);

  it("restores the same conversation, cycle, and compaction state after a restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-session-test-"));
    const session = new SessionStore(directory);
    await session.appendMessages([userMessage("Autonomous wakeup #1, please continue")]);
    await session.appendMessages([assistantMessage([{ type: "text", text: "working" }])]);
    await session.saveCycle(1);
    await session.saveCompaction({
      compactedThrough: 1,
      summary: "Earlier work",
      summaryTokensBefore: 90_000,
      summaryCreatedAt: 5,
      records: [{ createdAt: "now", tokensBefore: 90_000, thresholdTokens: 75_000, summarizedMessages: 1, retainedMessages: 1 }],
    });

    const restored = await new SessionStore(directory).load();
    expect(restored.messages).toHaveLength(2);
    expect(restored.cycle).toBe(1);
    expect(restored.compaction?.summary).toBe("Earlier work");
    // The last message is a completed assistant turn, so the next cycle is new work.
    expect(restored.resumable).toBe(false);
  });

  it("recovers the active cycle from a wakeup persisted before its sidecar", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-session-cycle-test-"));
    const session = new SessionStore(directory);
    // appendMessages models a kill between the transcript write and saveCycle.
    await session.appendMessages([userMessage("Autonomous wakeup #27, please continue")]);

    const restored = await new SessionStore(directory).load();
    expect(restored).toMatchObject({ cycle: 27, resumable: true, activeCycle: 27 });
  });

  it("repairs a transcript write cut off by a process kill", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-session-tail-test-"));
    const session = new SessionStore(directory);
    await session.appendMessages([userMessage("first")]);
    await writeFile(session.transcriptPath, `${await readFile(session.transcriptPath, "utf8")}{\"role\":\"assist`);

    const restored = await new SessionStore(directory).load();
    expect(restored.messages).toHaveLength(1);
    await new SessionStore(directory).appendMessages([assistantMessage([{ type: "text", text: "second" }])]);

    const again = await new SessionStore(directory).load();
    expect(again.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("closes tool calls the kill interrupted and continues that turn", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-session-resume-test-"));
    const session = new SessionStore(directory);
    await session.appendMessages([
      userMessage("Autonomous wakeup #4, please continue"),
      assistantMessage([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }], "toolUse"),
    ]);

    const restored = await session.load();
    expect(restored.interruptedToolCalls).toBe(1);
    expect(restored.resumable).toBe(true);
    expect(restored.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "call-1", isError: true });

    // The repair is durable too: a second restart must not re-open the same call.
    const again = await new SessionStore(directory).load();
    expect(again.interruptedToolCalls).toBe(0);
    expect(again.messages).toHaveLength(3);
  });

  it("keeps runtime failure markers and stored secrets out of durable state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-session-secret-test-"));
    const session = new SessionStore(directory);
    expect(isDurableMessage(assistantMessage([{ type: "text", text: "" }], "aborted"))).toBe(false);
    expect(isDurableMessage(assistantMessage([{ type: "text", text: "" }], "error"))).toBe(false);
    expect(isDurableMessage(userMessage("hello"))).toBe(true);

    await session.appendMessages([
      assistantMessage([{ type: "toolCall", id: "c", name: "set_api_key", arguments: { provider: "openai", apiKey: "never-write-me" } }], "toolUse"),
    ]);
    expect(await readFile(path.join(directory, "session-transcript.jsonl"), "utf8")).not.toContain("never-write-me");
  });

  it("gives a restarted agent the same transcript and finishes the interrupted turn", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-session-agent-test-"));
    const model = { contextWindow: 100_000, api: "openai-responses", provider: "openai", id: "gpt" } as Model<Api>;
    const reply = (text: string): AssistantMessage => ({
      role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "gpt",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    });
    const contexts: AgentMessage[][] = [];
    const build = async (): Promise<{ agent: Agent; session: SessionStore; restored: Awaited<ReturnType<SessionStore["load"]>> }> => {
      const session = new SessionStore(directory);
      const restored = await session.load();
      const agent = new Agent({
        initialState: { systemPrompt: "You are Maya.", model, thinkingLevel: "off", tools: [] },
        convertToLlm,
        streamFn: (_model, context) => {
          contexts.push(context.messages.slice());
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: reply("continued") }));
          return stream;
        },
      });
      if (restored.messages.length) agent.state.messages = restored.messages;
      agent.subscribe(async (event) => {
        if (event.type === "message_end" && isDurableMessage(event.message)) await session.recordMessage(event.message);
      });
      return { agent, session, restored };
    };

    const first = await build();
    await first.agent.prompt("Autonomous wakeup #1, please continue");
    expect(first.agent.state.messages).toHaveLength(2);

    // Restart: the second process must see the first one's conversation.
    const second = await build();
    expect(second.restored.messages).toHaveLength(2);
    expect(second.agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(second.restored.resumable).toBe(false);

    // Now simulate a kill mid-turn: a wakeup was persisted, the reply never was.
    await second.session.appendMessages([{ role: "user", content: [{ type: "text", text: "Autonomous wakeup #2, please continue" }], timestamp: Date.now() }]);
    const third = await build();
    expect(third.restored.resumable).toBe(true);
    await third.agent.continue();

    expect(contexts.at(-1)?.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(third.agent.state.errorMessage).toBeUndefined();
    expect((await new SessionStore(directory).load()).messages).toHaveLength(4);
  });

  it("clears the conversation without touching durable memory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-session-clear-test-"));
    const store = new RogueStore(directory);
    await store.remember("decision", "Keep going");
    const session = new SessionStore(directory);
    await session.appendMessages([userMessage("hello")]);
    await session.saveCycle(9);
    await session.clear();

    expect(await session.load()).toMatchObject({ messages: [], cycle: 0, resumable: false });
    expect(await store.recall("Keep going")).toHaveLength(1);
  });
});

describe("automatic context compaction", () => {
  it("caps the threshold at 150K or three quarters of the model window", () => {
    expect(compactionThreshold(1_000_000)).toBe(150_000);
    expect(compactionThreshold(100_000)).toBe(75_000);
  });

  it("replaces old model context with a native compaction summary and recent tail", async () => {
    const model = { contextWindow: 100_000 } as Model<Api>;
    const summarized: unknown[][] = [];
    const compactor = createAutomaticContextCompactor({
      models: {} as Models,
      getModel: () => model,
      summarize: async (messages) => { summarized.push(messages); return "Durable rolling summary"; },
    });
    const messages = [1, 2, 3].map((timestamp) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: "x".repeat(120_000) }],
      timestamp,
    }));
    const compacted = await compactor.transform(messages);

    expect(summarized[0]).toHaveLength(2);
    expect(compacted).toHaveLength(2);
    expect(compacted[0]).toMatchObject({ role: "compactionSummary", summary: "Durable rolling summary" });
    expect(compacted[1]).toBe(messages[2]);
    expect(compactor.records[0]).toMatchObject({ thresholdTokens: 75_000, summarizedMessages: 2, retainedMessages: 1 });
  });

  it("carries its summary across a restart instead of paying to rebuild it", async () => {
    const model = { contextWindow: 100_000 } as Model<Api>;
    const states: unknown[] = [];
    const first = createAutomaticContextCompactor({
      models: {} as Models,
      getModel: () => model,
      summarize: async () => "Durable rolling summary",
      onChange: (state) => { states.push(state); },
    });
    const messages = [1, 2, 3].map((timestamp) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: "x".repeat(120_000) }],
      timestamp,
    }));
    await first.transform(messages);
    expect(states).toHaveLength(1);

    // A new process, the same transcript: the compacted prefix must stay compacted.
    let summarized = 0;
    const restarted = createAutomaticContextCompactor({
      models: {} as Models,
      getModel: () => model,
      summarize: async () => { summarized += 1; return "rebuilt"; },
    });
    restarted.restore(first.snapshot(), messages);
    const compacted = await restarted.transform(messages);

    expect(summarized).toBe(0);
    expect(compacted).toHaveLength(2);
    expect(compacted[0]).toMatchObject({ role: "compactionSummary", summary: "Durable rolling summary" });
    expect(restarted.records).toHaveLength(1);
  });
});

describe("terminal ui", () => {
  it("measures, truncates, and wraps text the setup screens depend on", () => {
    expect(ui.displayWidth("Anthropic")).toBe(9);
    expect(ui.displayWidth("\x1b[1mAnthropic\x1b[22m")).toBe(9);
    expect(ui.displayWidth("康平")).toBe(4);
    expect(ui.displayWidth(ui.flag("JP"))).toBe(2);

    expect(ui.truncate("Anthropic", 20)).toBe("Anthropic");
    expect(ui.displayWidth(ui.truncate("a".repeat(40), 12))).toBe(12);
    // Styling costs no columns and survives the cut.
    const styled = ui.truncate(`\x1b[1m${"model catalog ".repeat(4)}\x1b[22m`, 10);
    expect(ui.displayWidth(styled)).toBeLessThanOrEqual(10);
    expect(styled).toContain("\x1b[1m");

    expect(ui.wrapText("one two three four five", 9)).toEqual(["one two", "three fo…"]);
    expect(ui.wrapText("one two three", 9, 3)).toEqual(["one two", "three"]);
    expect(ui.wrapText("", 20)).toEqual([]);
  });

  it("splits one read into separate keys so batched input is not lost", () => {
    expect(ui.parseKeys("\x1b[B\x1b[B\r")).toEqual(["\x1b[B", "\x1b[B", "\r"]);
    expect(ui.parseKeys("gpt")).toEqual(["g", "p", "t"]);
    expect(ui.parseKeys("\x1bOA\x1b[6~\x1b")).toEqual(["\x1bOA", "\x1b[6~", "\x1b"]);
    expect(ui.parseKeys("é")).toEqual(["é"]);
  });

  it("filters choices across every displayed field, ignoring styling", () => {
    const items = [
      { id: "anthropic", label: `Anthropic ${ui.style.success("● credentials found")}`, description: "API key" },
      { id: "openai", label: "OpenAI", description: "API key", searchText: "gpt" },
    ];
    expect(ui.filterItems(items, "anthropic api").map((item) => item.id)).toEqual(["anthropic"]);
    expect(ui.filterItems(items, "gpt").map((item) => item.id)).toEqual(["openai"]);
    expect(ui.filterItems(items, "")).toHaveLength(2);
  });
});
