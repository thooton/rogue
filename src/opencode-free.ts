import { createHash, randomUUID } from "node:crypto";
import type {
  Api,
  ApiStreamOptions,
  Context,
  Credential,
  DeferredCancelOptions,
  DeferredFetchOptions,
  Model,
  MutableModels,
  Provider,
  ProviderHeaders,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const OPENCODE_PROVIDER = "opencode";
const OPENCODE_API_KEY_ENV = "OPENCODE_API_KEY";
const ANONYMOUS_API_KEY = "opencode-free";
let fallbackIdentity = { projectId: randomUUID(), sessionId: randomUUID() };
const identityGenerations = new Map<string, number>();

/** OpenCode advertises promotional/free models with zero prices in its catalog. */
export function isFreeOpenCodeModel(model: Model<Api>): boolean {
  const rates = [model.cost, ...(model.cost.tiers ?? [])];
  return model.provider === OPENCODE_PROVIDER
    && rates.every((rate) => rate.input === 0 && rate.output === 0 && rate.cacheRead === 0 && rate.cacheWrite === 0);
}

/**
 * Produce an RFC 4122-shaped, deterministic identifier without exposing the
 * Rogue profile ID itself to the provider. Keeping the initial identity
 * derived from Pi's durable session key preserves affinity across restarts.
 */
function stableUUID(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Match OpenCode's real request semantics: project and session identify a
 * durable conversation for routing/cache affinity, while request is unique to
 * this inference call. Callers without a session key share process-local IDs.
 */
export function openCodeFreeHeaders(sessionId?: string): ProviderHeaders {
  const generation = sessionId ? (identityGenerations.get(sessionId) ?? 0) : 0;
  const identityKey = generation ? `${sessionId}:generation:${generation}` : sessionId;
  const projectId = identityKey ? stableUUID(`rogue:opencode:project:${identityKey}`) : fallbackIdentity.projectId;
  const openCodeSessionId = identityKey ? stableUUID(`rogue:opencode:session:${identityKey}`) : fallbackIdentity.sessionId;
  return {
    Authorization: null,
    "X-Api-Key": null,
    "User-Agent": "opencode/1.0.0",
    "x-opencode-project": projectId,
    "x-opencode-session": openCodeSessionId,
    "x-opencode-request": randomUUID(),
    "x-opencode-client": "opencode",
  };
}

/**
 * Replace every anonymous OpenCode affinity identifier after the provider has
 * rate-limited the current identity. The next request also gets its usual new
 * request UUID, so it is unrelated to the rejected request at every identity
 * layer OpenCode exposes.
 */
export function rotateOpenCodeFreeIdentity(sessionId?: string): void {
  if (!sessionId) {
    fallbackIdentity = { projectId: randomUUID(), sessionId: randomUUID() };
    return;
  }
  identityGenerations.set(sessionId, (identityGenerations.get(sessionId) ?? 0) + 1);
}

function mergeHeaders(base: ProviderHeaders | undefined, override: ProviderHeaders): ProviderHeaders {
  const merged = { ...base };
  for (const [name, value] of Object.entries(override)) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLocaleLowerCase() === name.toLocaleLowerCase()) delete merged[existing];
    }
    merged[name] = value;
  }
  return merged;
}

function freeRequestOptions<T extends { headers?: ProviderHeaders; sessionId?: string }>(
  model: Model<Api>,
  options: T | undefined,
): T | undefined {
  if (!isFreeOpenCodeModel(model)) return options;
  return {
    ...options,
    headers: mergeHeaders(options?.headers, openCodeFreeHeaders(options?.sessionId)),
  } as T;
}

function hasStoredOrAmbientKey(credential: Credential | undefined): boolean {
  return credential?.type === "api_key" && Boolean(credential.key)
    || Boolean(process.env[OPENCODE_API_KEY_ENV]?.trim());
}

/**
 * Extend Pi's OpenCode provider with the anonymous protocol used by the
 * official client and Big Pickle Proxy. Paid models retain normal API-key auth;
 * free models deliberately suppress a stored bearer key and use UUID headers.
 */
export function enableOpenCodeFreeModels(models: MutableModels): void {
  const provider = models.getProvider(OPENCODE_PROVIDER);
  const apiKey = provider?.auth.apiKey;
  if (!provider || !apiKey) return;

  const wrapped: Provider<Api> = {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        check: async (input) => {
          const configured = apiKey.check
            ? await apiKey.check(input)
            : await apiKey.resolve(input);
          return configured
            ? ("type" in configured ? configured : { source: configured.source, type: "api_key" as const })
            : { source: "OpenCode free models · no API key", type: "api_key" };
        },
        resolve: async (input) => {
          const configured = await apiKey.resolve(input);
          return configured ?? {
            auth: { apiKey: ANONYMOUS_API_KEY },
            source: "OpenCode free models · no API key",
          };
        },
      },
    },
    filterModels: (catalog, credential) => {
      const candidates = provider.filterModels?.(catalog, credential) ?? catalog;
      return hasStoredOrAmbientKey(credential) ? candidates : candidates.filter(isFreeOpenCodeModel);
    },
    stream: <T extends Api>(model: Model<T>, context: Context, options?: ApiStreamOptions<T>) =>
      provider.stream(model, context, freeRequestOptions(model, options)),
    streamSimple: (model, context, options?: SimpleStreamOptions) =>
      provider.streamSimple(model, context, freeRequestOptions(model, options)),
  };

  if (provider.fetchDeferred) {
    wrapped.fetchDeferred = (model, handle, options?: DeferredFetchOptions) =>
      provider.fetchDeferred!(model, handle, freeRequestOptions(model, options));
  }
  if (provider.cancelDeferred) {
    wrapped.cancelDeferred = (model, handle, options?: DeferredCancelOptions) =>
      provider.cancelDeferred!(model, handle, freeRequestOptions(model, options));
  }

  models.setProvider(wrapped);
}
