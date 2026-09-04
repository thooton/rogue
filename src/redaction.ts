const SECRET_KEY = /^(api_?key|secret|access_?token|refresh_?token|authorization|proxy_?url)$/i;

/**
 * JSON replacer that keeps credentials out of anything Rogue writes down or
 * serves. Tool arguments are scrubbed in the live transcript after the call
 * completes, but persisted and served copies are produced at arbitrary moments,
 * so they redact on their own rather than trusting that timing.
 */
export function redactSecrets(key: string, value: unknown): unknown {
  return SECRET_KEY.test(key) ? "<redacted>" : value;
}

export function redactedJson(value: unknown, space?: number): string {
  return JSON.stringify(value, redactSecrets, space);
}

/** Structured clone of `value` with every secret-looking field redacted. */
export function redacted<T>(value: T): T {
  return JSON.parse(redactedJson(value)) as T;
}
