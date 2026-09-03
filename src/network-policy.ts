export const ROGUE_PUBLIC_CHARACTER_LIMIT = 280;
export const ROGUE_DIRECT_CHARACTER_LIMIT = 2_000;

// NIP-04 encrypted DMs plus the NIP-17 chat-message, seal, and gift-wrap kinds.
const DIRECT_MESSAGE_KINDS = new Set([4, 13, 14, 1059]);

export function isDirectMessageKind(kind: number): boolean {
  return DIRECT_MESSAGE_KINDS.has(kind);
}

export function networkCharacterCount(content: string): number {
  // Count Unicode code points, so an astral character is not charged twice as a
  // UTF-16 surrogate pair. This also matches JSON Schema's definition of length.
  return [...content].length;
}

export function networkCharacterLimit(kind: number): number {
  return isDirectMessageKind(kind) ? ROGUE_DIRECT_CHARACTER_LIMIT : ROGUE_PUBLIC_CHARACTER_LIMIT;
}

export function assertNetworkContent(content: string, kind: number): void {
  const count = networkCharacterCount(content);
  const limit = networkCharacterLimit(kind);
  if (count > limit) {
    const category = isDirectMessageKind(kind) ? "direct message" : "public post";
    throw new Error(`Rogue Network ${category} exceeds the ${limit}-character limit (${count} characters).`);
  }
}

export function assertNetworkDraftContent(content: string, audience: "public" | "direct"): void {
  assertNetworkContent(content, audience === "direct" ? 4 : 1);
}
