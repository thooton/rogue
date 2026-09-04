import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import * as bedrockProviderModule from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createCodingTools, createFindTool, createGrepTool, createLsTool } from "@earendil-works/pi-coding-agent";
import { FileCredentialStore } from "./credentials.js";
import { FileModelsStore } from "./model-catalog-store.js";
import { CustomProviderStore, registerCustomProviders } from "./custom-providers.js";
import { enableOpenCodeFreeModels } from "./opencode-free.js";
import { RogueConfigStore } from "./config.js";
import { applyHttpProxy } from "./http-proxy.js";

let initialized = false;

/** Register Pi implementations that otherwise use filesystem-relative imports. */
export function initializeBundledProviderRuntime(): void {
  if (initialized) return;
  registerBunOAuthFlows();
  setBedrockProviderModule(bedrockProviderModule);
  initialized = true;
}

export interface RogueModelRuntime {
  models: MutableModels;
  credentials: FileCredentialStore;
  modelsStore: FileModelsStore;
  customProviders: CustomProviderStore;
}

/**
 * The one place that assembles Rogue's model runtime: Pi's built-in providers
 * plus every endpoint this installation has been pointed at itself. First-run
 * setup, bootstrap import, and the agent loop all build it here, so a route
 * naming a local or otherwise custom server resolves the same way in each.
 */
export async function createRogueModels(stateDirectory: string): Promise<RogueModelRuntime> {
  initializeBundledProviderRuntime();
  const config = new RogueConfigStore(stateDirectory);
  await applyHttpProxy(await config.getHttpProxy());
  const credentials = new FileCredentialStore(`${stateDirectory}/auth.json`);
  const modelsStore = new FileModelsStore(`${stateDirectory}/model-catalogs.json`);
  const models = builtinModels({ credentials, modelsStore });
  enableOpenCodeFreeModels(models);
  const customProviders = new CustomProviderStore(stateDirectory);
  await registerCustomProviders(models, customProviders);
  return { models, credentials, modelsStore, customProviders };
}

export async function verifyBundledProviderRuntime(): Promise<{
  providers: number;
  oauth: "embedded";
  bedrock: "embedded";
  codingTools: number;
}> {
  initializeBundledProviderRuntime();
  const models = builtinModels();
  const oauth = models.getProvider("openai-codex")?.auth.oauth;
  if (!oauth) throw new Error("The bundled OpenAI Codex OAuth provider is unavailable.");
  const auth = await oauth.toAuth({
    type: "oauth",
    access: "bundle-self-check",
    refresh: "bundle-self-check",
    expires: Date.now() + 60_000,
  });
  if (auth.apiKey !== "bundle-self-check") throw new Error("The bundled OAuth provider returned an invalid result.");
  if (typeof bedrockProviderModule.stream !== "function" || typeof bedrockProviderModule.streamSimple !== "function") {
    throw new Error("The bundled Bedrock provider is unavailable.");
  }
  const codingTools = [
    ...createCodingTools(process.cwd()),
    createGrepTool(process.cwd()),
    createFindTool(process.cwd()),
    createLsTool(process.cwd()),
  ];
  const expected = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  if (codingTools.map((tool) => tool.name).join(",") !== expected.join(",")) {
    throw new Error("The bundled Pi coding-agent tools are incomplete.");
  }
  return { providers: models.getProviders().length, oauth: "embedded", bedrock: "embedded", codingTools: codingTools.length };
}
