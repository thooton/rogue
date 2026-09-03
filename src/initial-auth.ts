import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { FileCredentialStore } from "./credentials.js";
import { FileModelsStore } from "./model-catalog-store.js";
import { RogueConfigStore } from "./config.js";
import { initializeBundledProviderRuntime } from "./provider-runtime.js";
import { NostrService } from "./nostr.js";

interface InitialRoute {
  provider: string;
  model?: string;
  priority?: number;
  credential?: unknown;
  apiKey?: string;
}

interface InitialAuthDocument {
  credentials?: Record<string, unknown>;
  routes?: InitialRoute[];
  providers?: InitialRoute[];
  relays?: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCredential(value: unknown, provider: string): Credential {
  if (typeof value === "string" && value) return { type: "api_key", key: value };
  if (!isObject(value) || (value.type !== "api_key" && value.type !== "oauth")) {
    throw new Error(`initial_auth.json has an invalid credential for ${provider}.`);
  }
  if (value.type === "api_key") {
    if (value.key !== undefined && typeof value.key !== "string") throw new Error(`The API key for ${provider} must be a string.`);
    if (value.env !== undefined && !isObject(value.env)) throw new Error(`The credential environment for ${provider} must be an object.`);
    for (const [name, setting] of Object.entries(value.env ?? {})) {
      if (typeof setting !== "string") throw new Error(`Credential setting ${name} for ${provider} must be a string.`);
    }
  } else if (typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") {
    throw new Error(`The OAuth credential for ${provider} requires access, refresh, and expires fields.`);
  }
  return value as unknown as Credential;
}

function validateRoute(value: unknown): asserts value is InitialRoute {
  if (!isObject(value) || typeof value.provider !== "string" || !value.provider) {
    throw new Error("Every initial_auth.json provider/route needs a provider ID.");
  }
  if (value.model !== undefined && typeof value.model !== "string") throw new Error(`The model for ${value.provider} must be a string.`);
  if (value.priority !== undefined && (!Number.isSafeInteger(value.priority) || (value.priority as number) < 0)) {
    throw new Error(`The priority for ${value.provider} must be a non-negative integer.`);
  }
  if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || !value.apiKey)) {
    throw new Error(`The API key for ${value.provider} must be a non-empty string.`);
  }
  if (value.credential !== undefined) normalizeCredential(value.credential, value.provider);
}

async function existingPath(stateDirectory: string, explicitPath?: string): Promise<string | undefined> {
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : [...new Set([path.resolve("initial_auth.json"), path.resolve(stateDirectory, "initial_auth.json")])];
  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

/** Import and consume non-interactive credentials/routes supplied by a parent Rogue or deployer. */
export async function importInitialAuthentication(stateDirectory = ".rogue", explicitPath?: string): Promise<boolean> {
  const bootstrapPath = await existingPath(stateDirectory, explicitPath);
  if (!bootstrapPath) return false;

  const parsed = JSON.parse(await readFile(bootstrapPath, "utf8")) as unknown;
  if (!isObject(parsed)) throw new Error("initial_auth.json must contain a JSON object.");
  const hasStructuredKeys = "credentials" in parsed || "routes" in parsed || "providers" in parsed || "relays" in parsed;
  const document: InitialAuthDocument = hasStructuredKeys
    ? parsed as InitialAuthDocument
    : { credentials: parsed };
  if (document.credentials !== undefined && !isObject(document.credentials)) {
    throw new Error("initial_auth.json credentials must be an object keyed by provider ID.");
  }
  if (document.routes !== undefined && !Array.isArray(document.routes)) throw new Error("initial_auth.json routes must be an array.");
  if (document.providers !== undefined && !Array.isArray(document.providers)) throw new Error("initial_auth.json providers must be an array.");
  if (document.relays !== undefined && !Array.isArray(document.relays)) throw new Error("initial_auth.json relays must be an array.");
  const relays = (document.relays ?? []).map((relay) => {
    if (typeof relay !== "string") throw new Error("Every initial_auth.json relay must be a URL string.");
    const url = new URL(relay.trim());
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Initial relay URLs must use ws:// or wss://.");
    return url.toString();
  });

  const credentialsByProvider = new Map<string, Credential>();
  for (const [provider, credential] of Object.entries(document.credentials ?? {})) {
    credentialsByProvider.set(provider, normalizeCredential(credential, provider));
  }
  const compactRoutes = document.providers ?? [];
  const routes = [...(document.routes ?? []), ...compactRoutes];
  for (const route of routes) {
    validateRoute(route);
    if (route.credential !== undefined) credentialsByProvider.set(route.provider, normalizeCredential(route.credential, route.provider));
    else if (route.apiKey) credentialsByProvider.set(route.provider, { type: "api_key", key: route.apiKey });
  }
  if (!credentialsByProvider.size && !routes.length && !relays.length) {
    throw new Error("initial_auth.json must define at least one credential, provider route, or relay.");
  }

  initializeBundledProviderRuntime();
  const credentials = new FileCredentialStore(`${stateDirectory}/auth.json`);
  const models = builtinModels({
    credentials,
    modelsStore: new FileModelsStore(`${stateDirectory}/model-catalogs.json`),
  });
  for (const [providerId, credential] of credentialsByProvider) {
    const provider = models.getProvider(providerId);
    if (!provider) throw new Error(`initial_auth.json names unknown provider ${providerId}.`);
    if (!provider.auth[credential.type === "api_key" ? "apiKey" : "oauth"]) {
      throw new Error(`${provider.name} does not support ${credential.type} credentials.`);
    }
  }
  for (const route of routes) {
    if (!models.getProvider(route.provider)) throw new Error(`initial_auth.json names unknown provider ${route.provider}.`);
  }

  for (const [providerId, credential] of credentialsByProvider) {
    await credentials.modify(providerId, async () => structuredClone(credential));
  }
  await models.refresh({ allowNetwork: false });
  const refresh = await models.refresh({ providers: [...credentialsByProvider.keys()], force: true });
  for (const [providerId, error] of refresh.errors) {
    if (!models.getModels(providerId).length) throw new Error(`Could not load ${providerId}'s model catalog: ${error.message}`);
  }

  const requestedRoutes: InitialRoute[] = routes.length
    ? routes
    : [...credentialsByProvider.keys()].map((provider) => ({ provider }));
  const config = new RogueConfigStore(stateDirectory);
  const configured: { provider: string; model: string; priority: number }[] = [];
  for (let index = 0; index < requestedRoutes.length; index += 1) {
    const route = requestedRoutes[index]!;
    let model: Model<Api> | undefined;
    const available = await models.getAvailable(route.provider);
    if (route.model) model = available.find((candidate) => candidate.id === route.model);
    else model = available[0];
    if (!model) {
      throw new Error(`No authenticated model matches ${route.provider}${route.model ? `/${route.model}` : ""}.`);
    }
    const priority = route.priority ?? index * 10;
    await config.configureProvider({ provider: route.provider, model: model.id, priority });
    configured.push({ provider: route.provider, model: model.id, priority });
  }

  const nostr = new NostrService(stateDirectory);
  for (const relay of relays) await nostr.addRelay(relay);

  await unlink(bootstrapPath);
  if (configured.length) console.log(`Imported one-time authentication for ${configured.map((route) => `${route.provider}/${route.model}`).join(", ")}.`);
  if (relays.length) console.log(`Imported ${relays.length} Rogue Network relay${relays.length === 1 ? "" : "s"}.`);
  console.log(`Consumed and deleted ${bootstrapPath}.`);
  return true;
}
