import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { RogueConfigStore } from "./config.js";
import { createRogueModels } from "./provider-runtime.js";
import { normalizeCustomProvider, saveCustomProvider, type CustomProviderDefinition } from "./custom-providers.js";
import { NostrService } from "./nostr.js";
import {
  applyHttpProxy,
  normalizeHttpProxySettings,
  redactHttpProxyUrl,
  type HttpProxySettings,
} from "./http-proxy.js";

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
  customProviders?: unknown[];
  relays?: string[];
  httpProxy?: unknown;
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
  const hasStructuredKeys = "credentials" in parsed || "routes" in parsed || "providers" in parsed
    || "customProviders" in parsed || "relays" in parsed || "httpProxy" in parsed;
  const document: InitialAuthDocument = hasStructuredKeys
    ? parsed as InitialAuthDocument
    : { credentials: parsed };
  if (document.credentials !== undefined && !isObject(document.credentials)) {
    throw new Error("initial_auth.json credentials must be an object keyed by provider ID.");
  }
  if (document.routes !== undefined && !Array.isArray(document.routes)) throw new Error("initial_auth.json routes must be an array.");
  if (document.providers !== undefined && !Array.isArray(document.providers)) throw new Error("initial_auth.json providers must be an array.");
  if (document.customProviders !== undefined && !Array.isArray(document.customProviders)) {
    throw new Error("initial_auth.json customProviders must be an array.");
  }
  if (document.relays !== undefined && !Array.isArray(document.relays)) throw new Error("initial_auth.json relays must be an array.");
  const httpProxy: HttpProxySettings | undefined = document.httpProxy === undefined
    ? undefined
    : normalizeHttpProxySettings(document.httpProxy);
  const customDefinitions: CustomProviderDefinition[] = (document.customProviders ?? []).map(normalizeCustomProvider);
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
  if (!credentialsByProvider.size && !routes.length && !relays.length && !customDefinitions.length && !httpProxy) {
    throw new Error("initial_auth.json must define at least one credential, provider route, custom provider, relay, or HTTP proxy.");
  }

  if (httpProxy) {
    const config = new RogueConfigStore(stateDirectory);
    await config.configureHttpProxy(httpProxy);
    await applyHttpProxy(httpProxy);
  }
  const { models, credentials, customProviders } = await createRogueModels(stateDirectory);
  // Custom endpoints are registered first: a credential or route in the same
  // file is allowed to name one, and a keyless local server is often the only
  // provider a bootstrapped child is given.
  for (const definition of customDefinitions) await saveCustomProvider(models, customProviders, definition);
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
  // A custom endpoint usually carries no credential at all, so it is refreshed
  // by name rather than by having one.
  const refreshable = [...new Set([...credentialsByProvider.keys(), ...customDefinitions.map((definition) => definition.id)])];
  const refresh = await models.refresh({ providers: refreshable, force: true });
  for (const [providerId, error] of refresh.errors) {
    if (!models.getModels(providerId).length) throw new Error(`Could not load ${providerId}'s model catalog: ${error.message}`);
  }

  const requestedRoutes: InitialRoute[] = routes.length
    ? routes
    : refreshable.map((provider) => ({ provider }));
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
  if (customDefinitions.length) {
    console.log(`Imported ${customDefinitions.length} custom endpoint${customDefinitions.length === 1 ? "" : "s"}: ${customDefinitions.map((definition) => `${definition.id} (${definition.baseUrl})`).join(", ")}.`);
  }
  if (configured.length) console.log(`Imported one-time authentication for ${configured.map((route) => `${route.provider}/${route.model}`).join(", ")}.`);
  if (relays.length) console.log(`Imported ${relays.length} Rogue Network relay${relays.length === 1 ? "" : "s"}.`);
  if (httpProxy) console.log(`Imported HTTP proxy ${redactHttpProxyUrl(httpProxy.url)}.`);
  console.log(`Consumed and deleted ${bootstrapPath}.`);
  return true;
}
