import {
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import type { ProviderEnv } from "@earendil-works/pi-ai";

export interface HttpProxySettings {
  url: string;
  noProxy?: string;
}

export interface HttpProxyStatus {
  source: "stored" | "environment" | "direct";
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

const ORIGINAL_DISPATCHER = getGlobalDispatcher();
let managedDispatcher: Dispatcher | undefined;
let activeSettings: HttpProxySettings | undefined;

function nonEmpty(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

/** Accept one HTTP(S) forward proxy, optionally carrying basic-auth userinfo. */
export function normalizeHttpProxySettings(value: unknown): HttpProxySettings {
  const input = typeof value === "string" ? { url: value } : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("HTTP proxy configuration must be a URL or an object containing url and optional noProxy.");
  }
  const record = input as Record<string, unknown>;
  const raw = nonEmpty(record.url, "HTTP proxy URL");
  if (!raw) throw new Error("An HTTP proxy URL is required.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The raw value may contain basic-auth credentials, so validation errors
    // must not repeat it into the transcript or setup UI.
    throw new Error("The HTTP proxy URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("HTTP proxy URLs must use http:// or https://; SOCKS and PAC proxies are not supported.");
  }
  if (!url.hostname) throw new Error("The HTTP proxy URL needs a hostname.");
  if (url.search || url.hash) throw new Error("An HTTP proxy URL cannot contain a query string or fragment.");
  const noProxy = nonEmpty(record.noProxy, "NO_PROXY bypass list");
  return { url: url.toString(), noProxy };
}

/** Render a proxy endpoint without ever returning embedded credentials. */
export function redactHttpProxyUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) {
    url.username = "redacted";
    url.password = "redacted";
  }
  return url.toString();
}

function environmentValue(lower: string, upper: string): string | undefined {
  return process.env[lower]?.trim() || process.env[upper]?.trim() || undefined;
}

/** Non-secret status suitable for UI, tools, and logs. */
export function httpProxyStatus(settings: HttpProxySettings | undefined): HttpProxyStatus {
  if (settings) {
    const proxy = redactHttpProxyUrl(settings.url);
    return { source: "stored", httpProxy: proxy, httpsProxy: proxy, noProxy: settings.noProxy };
  }
  const httpProxy = environmentValue("http_proxy", "HTTP_PROXY");
  const httpsProxy = environmentValue("https_proxy", "HTTPS_PROXY") ?? httpProxy;
  const noProxy = environmentValue("no_proxy", "NO_PROXY");
  if (!httpProxy && !httpsProxy) return { source: "direct", noProxy };
  return {
    source: "environment",
    httpProxy: httpProxy ? redactHttpProxyUrl(httpProxy) : undefined,
    httpsProxy: httpsProxy ? redactHttpProxyUrl(httpsProxy) : undefined,
    noProxy,
  };
}

/**
 * Install proxy routing for global fetch consumers. With no stored setting,
 * standard proxy environment variables are honored; with neither, Node's
 * original dispatcher is restored. Reconfiguration takes effect immediately.
 */
export async function applyHttpProxy(settings: HttpProxySettings | undefined): Promise<HttpProxyStatus> {
  const normalized = settings ? normalizeHttpProxySettings(settings) : undefined;
  const status = httpProxyStatus(normalized);
  const next = status.source === "direct"
    ? undefined
    : normalized
      ? new EnvHttpProxyAgent({
        httpProxy: normalized.url,
        httpsProxy: normalized.url,
        noProxy: normalized.noProxy,
      })
      : new EnvHttpProxyAgent();
  const previous = managedDispatcher;
  managedDispatcher = next;
  activeSettings = normalized;
  setGlobalDispatcher(next ?? ORIGINAL_DISPATCHER);
  if (previous && previous !== next) await previous.destroy();
  return status;
}

/** Provider-scoped proxy settings for Pi adapters that do not use fetch. */
export function httpProxyProviderEnv(): ProviderEnv | undefined {
  if (!activeSettings) return undefined;
  return {
    http_proxy: activeSettings.url,
    https_proxy: activeSettings.url,
    ...(activeSettings.noProxy ? { no_proxy: activeSettings.noProxy } : {}),
  };
}

/** Whether Rogue currently routes HTTP(S) through a stored or environment proxy. */
export function isHttpProxyActive(): boolean {
  return managedDispatcher !== undefined;
}

/** Restore the dispatcher that existed before Rogue configured proxying. */
export async function resetHttpProxyForTests(): Promise<void> {
  const previous = managedDispatcher;
  managedDispatcher = undefined;
  activeSettings = undefined;
  setGlobalDispatcher(ORIGINAL_DISPATCHER);
  if (previous) await previous.destroy();
}
