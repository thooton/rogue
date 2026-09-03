import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  createProvider,
  type Api,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderAuth,
  type ProviderStreams,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";

/**
 * Wire formats a custom endpoint can speak. Local servers — llama.cpp, Ollama,
 * vLLM, SGLang, LM Studio, text-generation-webui — and nearly every proxy or
 * private gateway expose the OpenAI chat-completions dialect, so it is the
 * default; the other two are here for endpoints that emulate a newer OpenAI or
 * an Anthropic surface instead.
 */
export const CUSTOM_PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

/**
 * A served local model rarely runs at its architectural context length, and an
 * over-estimate is the expensive mistake: context compaction trusts this number
 * and a request built against a window the server does not have is rejected
 * outright. 32K is the common floor for current local builds; raise it per
 * provider or per model once the real limit is known.
 */
export const DEFAULT_CUSTOM_CONTEXT_WINDOW = 32_768;
export const DEFAULT_CUSTOM_MAX_TOKENS = 8_192;

/** OpenAI clients refuse an empty key, and a keyless local server ignores this one. */
const KEYLESS_API_KEY = "local";

const DISCOVERY_TIMEOUT_MS = 15_000;

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface CustomModelDefinition {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CustomProviderDefinition {
  id: string;
  name?: string;
  /** Request root exactly as the client uses it, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  api?: CustomProviderApi;
  /** Environment variable consulted when no credential is stored. */
  apiKeyEnvVar?: string;
  /** When true the endpoint counts as unconfigured until a key is stored. */
  requiresApiKey?: boolean;
  headers?: Record<string, string>;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /** Models the endpoint serves. Declaring any of them replaces catalog discovery. */
  models?: CustomModelDefinition[];
  /** Compatibility overrides merged over Rogue's conservative local-server defaults. */
  compat?: Record<string, unknown>;
  /** Extra sampling parameters sent verbatim by the OpenAI-compatible adapters. */
  samplingParams?: Record<string, unknown>;
}

/**
 * Compatibility defaults for an endpoint Pi does not recognize. Pi infers these
 * from the base URL, and its inference for an unknown host is the current
 * OpenAI cloud dialect: a `developer` role, `max_completion_tokens`, `store`,
 * strict tool schemas, `reasoning_effort`, and 24-hour prompt cache retention.
 * Self-hosted servers reject or ignore all of it, so what is pinned here is the
 * conservative subset every one of them accepts. A definition's own `compat`
 * wins, for an endpoint that does support more.
 */
const LOCAL_COMPAT: Record<CustomProviderApi, Record<string, unknown>> = {
  "openai-completions": {
    supportsDeveloperRole: false,
    supportsStore: false,
    supportsStrictMode: false,
    supportsReasoningEffort: false,
    supportsLongCacheRetention: false,
    maxTokensField: "max_tokens",
  },
  "openai-responses": {
    supportsDeveloperRole: false,
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
  },
  "anthropic-messages": {
    supportsLongCacheRetention: false,
  },
};

const API_STREAMS: Record<CustomProviderApi, () => ProviderStreams> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`A custom provider's ${field} must be a non-empty string.`);
  return value.trim();
}

function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`A custom provider's ${field} must be a positive integer.`);
  }
  return value as number;
}

function optionalFlag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`A custom provider's ${field} must be true or false.`);
  return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`A custom provider's ${field} must be an object.`);
  return { ...value };
}

/** Accepts what a client would actually be pointed at and rejects anything it could not request. */
export function normalizeCustomBaseUrl(value: unknown): string {
  const raw = optionalString(value, "base URL");
  if (!raw) throw new Error("A custom provider needs a base URL, e.g. http://127.0.0.1:11434/v1.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${raw} is not a valid URL. Include the scheme, e.g. http://127.0.0.1:11434/v1.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("A custom provider's base URL must use http:// or https://.");
  }
  if (url.search || url.hash) throw new Error("A custom provider's base URL cannot carry a query string or fragment.");
  return url.toString().replace(/\/+$/, "");
}

function normalizeModel(value: unknown): CustomModelDefinition {
  const source = typeof value === "string" ? { id: value } : value;
  if (!isObject(source)) throw new Error("Every custom model must be a model ID string or an object.");
  const id = optionalString(source.id, "model ID");
  if (!id) throw new Error("Every custom model needs an ID, exactly as the endpoint names it.");
  const contextWindow = optionalCount(source.contextWindow, "context window");
  return {
    id,
    name: optionalString(source.name, "model name"),
    reasoning: optionalFlag(source.reasoning, "reasoning flag"),
    contextWindow,
    maxTokens: optionalCount(source.maxTokens, "max output tokens"),
  };
}

/** Validate and canonicalize one definition, from any source: tool call, prompt, flag, or file. */
export function normalizeCustomProvider(value: unknown): CustomProviderDefinition {
  if (!isObject(value)) throw new Error("A custom provider must be a JSON object.");
  const id = (optionalString(value.id, "ID") ?? "").toLocaleLowerCase();
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(`Invalid custom provider ID: ${id || "(empty)"}. Use lowercase letters, digits, dots, dashes, or underscores.`);
  }
  if (value.models !== undefined && !Array.isArray(value.models)) throw new Error("A custom provider's models must be an array.");
  const api = optionalString(value.api, "API") as CustomProviderApi | undefined;
  if (api && !CUSTOM_PROVIDER_APIS.includes(api)) {
    throw new Error(`Unsupported custom provider API: ${api}. Choose one of ${CUSTOM_PROVIDER_APIS.join(", ")}.`);
  }
  const headers = optionalRecord(value.headers, "headers");
  for (const [name, header] of Object.entries(headers ?? {})) {
    if (typeof header !== "string") throw new Error(`The custom provider header ${name} must be a string.`);
  }
  const models = (value.models as unknown[] | undefined)?.map(normalizeModel);
  return {
    id,
    name: optionalString(value.name, "name"),
    baseUrl: normalizeCustomBaseUrl(value.baseUrl),
    api,
    apiKeyEnvVar: optionalString(value.apiKeyEnvVar, "API key environment variable"),
    requiresApiKey: optionalFlag(value.requiresApiKey, "API key requirement"),
    headers: headers as Record<string, string> | undefined,
    contextWindow: optionalCount(value.contextWindow, "context window"),
    maxTokens: optionalCount(value.maxTokens, "max output tokens"),
    reasoning: optionalFlag(value.reasoning, "reasoning flag"),
    models: models?.length ? models : undefined,
    compat: optionalRecord(value.compat, "compatibility overrides"),
    samplingParams: optionalRecord(value.samplingParams, "sampling parameters"),
  };
}

/** Parse one `--custom-provider <id>=<base-url>` command-line value. */
export function parseCustomProviderSpec(value: string): CustomProviderDefinition {
  const separator = value.indexOf("=");
  if (separator < 1) {
    throw new Error(`--custom-provider expects <id>=<base-url>, for example local=http://127.0.0.1:11434/v1 (received ${value}).`);
  }
  return normalizeCustomProvider({ id: value.slice(0, separator), baseUrl: value.slice(separator + 1) });
}

/** A stable, readable provider ID suggestion derived from an endpoint URL. */
export function suggestCustomProviderId(baseUrl: string, taken: ReadonlySet<string> = new Set()): string {
  let host = "custom";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    // Suggestion only: an unparseable URL is reported by the base URL prompt.
  }
  const base = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)$/.test(host)
    ? "local"
    : host.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLocaleLowerCase() || "custom";
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function providerName(definition: CustomProviderDefinition): string {
  return definition.name ?? definition.id;
}

function providerApi(definition: CustomProviderDefinition): CustomProviderApi {
  return definition.api ?? "openai-completions";
}

function buildModel(definition: CustomProviderDefinition, model: CustomModelDefinition): Model<Api> {
  const contextWindow = model.contextWindow ?? definition.contextWindow ?? DEFAULT_CUSTOM_CONTEXT_WINDOW;
  const api = providerApi(definition);
  return {
    id: model.id,
    name: model.name ?? model.id,
    api,
    provider: definition.id,
    baseUrl: definition.baseUrl,
    reasoning: model.reasoning ?? definition.reasoning ?? false,
    input: ["text"],
    // A self-hosted model bills nothing. A metered endpoint reports its own
    // spend through usage when it has any, and Rogue never invents a price.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(model.maxTokens ?? definition.maxTokens ?? DEFAULT_CUSTOM_MAX_TOKENS, contextWindow),
    samplingParams: definition.samplingParams,
    headers: definition.headers,
    compat: { ...LOCAL_COMPAT[api], ...definition.compat } as Model<Api>["compat"],
  };
}

function requestHeaders(definition: CustomProviderDefinition, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { ...definition.headers };
  if (providerApi(definition) === "anthropic-messages") {
    headers["anthropic-version"] ??= "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * The catalog endpoint sits where the client already points: the OpenAI
 * adapters append their paths to the base URL directly, so the model list is
 * `<base>/models`, while the Anthropic adapter versions its own paths.
 */
function catalogUrl(definition: CustomProviderDefinition): string {
  return providerApi(definition) === "anthropic-messages"
    ? `${definition.baseUrl}/v1/models`
    : `${definition.baseUrl}/models`;
}

/** Context length under any of the names local servers publish it, when they publish it at all. */
function reportedContextWindow(entry: Record<string, unknown>): number | undefined {
  const meta = isObject(entry.meta) ? entry.meta : {};
  for (const candidate of [entry.context_length, entry.context_window, entry.max_model_len, meta.n_ctx_train, entry.n_ctx]) {
    if (Number.isSafeInteger(candidate) && (candidate as number) > 0) return candidate as number;
  }
  return undefined;
}

async function discoverModels(
  definition: CustomProviderDefinition,
  context: RefreshModelsContext,
): Promise<Model<Api>[]> {
  const url = catalogUrl(definition);
  const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]);
  let response: Response;
  try {
    response = await fetch(url, { headers: requestHeaders(definition, apiKey), signal });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach ${url}: ${reason}. Check that the endpoint is running, or declare its models explicitly.`);
  }
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}. Check the base URL and credentials, or declare the models explicitly.`);
  }
  const payload = (await response.json()) as unknown;
  const entries = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.data)
      ? payload.data
      : isObject(payload) && Array.isArray(payload.models)
        ? payload.models
        : [];
  const discovered: Model<Api>[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = typeof entry === "string" ? { id: entry } : entry;
    if (!isObject(record)) continue;
    const id = [record.id, record.name, record.model].find((value) => typeof value === "string" && value) as string | undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    discovered.push(buildModel(definition, {
      id,
      name: typeof record.display_name === "string" ? record.display_name : undefined,
      contextWindow: reportedContextWindow(record),
    }));
  }
  return discovered;
}

function createAuth(definition: CustomProviderDefinition): ProviderAuth {
  const name = `${providerName(definition)} API key`;
  return {
    apiKey: {
      name,
      async login(interaction) {
        const key = await interaction.prompt({ type: "secret", message: name, signal: interaction.signal });
        return { type: "api_key", key: key.trim() };
      },
      async resolve({ ctx, credential }) {
        const stored = credential?.key?.trim();
        const fromEnvironment = definition.apiKeyEnvVar ? (await ctx.env(definition.apiKeyEnvVar))?.trim() : undefined;
        const key = stored || fromEnvironment;
        if (key) return { auth: { apiKey: key }, source: stored ? "stored API key" : definition.apiKeyEnvVar };
        // A keyless endpoint is configured by virtue of existing. Reporting it
        // as unconfigured would hide it from route selection and from every
        // catalog refresh, which is the whole point of pointing at it.
        if (definition.requiresApiKey) return undefined;
        return { auth: { apiKey: KEYLESS_API_KEY }, source: `${definition.baseUrl} · no key required` };
      },
    },
  };
}

/** Build the Pi provider one stored definition describes. */
export function createCustomProvider(definition: CustomProviderDefinition): Provider {
  const declared = definition.models?.map((model) => buildModel(definition, model)) ?? [];
  return createProvider({
    id: definition.id,
    name: providerName(definition),
    baseUrl: definition.baseUrl,
    auth: createAuth(definition),
    models: declared,
    // Declared models are the endpoint's contract as its operator stated it;
    // asking a server that may not answer would only be able to contradict it.
    fetchModels: declared.length ? undefined : (context) => discoverModels(definition, context),
    api: API_STREAMS[providerApi(definition)](),
  });
}

interface CustomProviderFile {
  providers: CustomProviderDefinition[];
}

/** Private, atomic persistence for endpoints this installation has been pointed at. */
export class CustomProviderStore {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(stateDirectory: string) {
    this.path = path.resolve(stateDirectory, "custom-providers.json");
  }

  private async load(): Promise<CustomProviderFile> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: [] };
      throw error;
    }
    const providers = isObject(parsed) && Array.isArray(parsed.providers) ? parsed.providers : undefined;
    if (!providers) throw new Error(`${this.path} must contain a JSON object with a providers array.`);
    return { providers: providers.map(normalizeCustomProvider) };
  }

  private async write(file: CustomProviderFile): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async mutate<T>(operation: (file: CustomProviderFile) => T): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      const file = await this.load();
      const result = operation(file);
      await this.write(file);
      return result;
    } finally {
      release();
    }
  }

  async list(): Promise<CustomProviderDefinition[]> {
    return (await this.load()).providers;
  }

  async get(id: string): Promise<CustomProviderDefinition | undefined> {
    return (await this.list()).find((definition) => definition.id === id);
  }

  async save(definition: CustomProviderDefinition): Promise<void> {
    await this.mutate((file) => {
      const index = file.providers.findIndex((candidate) => candidate.id === definition.id);
      if (index >= 0) file.providers[index] = definition;
      else file.providers.push(definition);
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate((file) => {
      const index = file.providers.findIndex((candidate) => candidate.id === id);
      if (index < 0) return false;
      file.providers.splice(index, 1);
      return true;
    });
  }
}

/**
 * Add every stored endpoint to a freshly built collection of Pi's own
 * providers. Registration happens before anything reads a route, so a custom
 * ID that shadows a built-in provider is a configuration error rather than a
 * silent substitution of the model a route names.
 */
export async function registerCustomProviders(
  models: MutableModels,
  store: CustomProviderStore,
): Promise<CustomProviderDefinition[]> {
  const definitions = await store.list();
  for (const definition of definitions) {
    if (models.getProvider(definition.id)) {
      throw new Error(`Custom provider ${definition.id} in ${store.path} shadows a built-in Pi provider. Rename or remove it.`);
    }
    models.setProvider(createCustomProvider(definition));
  }
  return definitions;
}

/** Persist one endpoint and make it usable immediately, without a restart. */
export async function saveCustomProvider(
  models: MutableModels,
  store: CustomProviderStore,
  input: unknown,
): Promise<CustomProviderDefinition> {
  const definition = normalizeCustomProvider(input);
  if (models.getProvider(definition.id) && !(await store.get(definition.id))) {
    throw new Error(`Provider ID ${definition.id} already belongs to a built-in Pi provider. Choose another ID.`);
  }
  await store.save(definition);
  models.setProvider(createCustomProvider(definition));
  return definition;
}

/** Forget one endpoint: both its stored definition and its live registration. */
export async function removeCustomProvider(
  models: MutableModels,
  store: CustomProviderStore,
  id: string,
): Promise<boolean> {
  if (!(await store.remove(id))) return false;
  models.deleteProvider(id);
  return true;
}
