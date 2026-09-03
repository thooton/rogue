export const ROGUE_PUBLIC_CHARACTER_LIMIT = 280;
export const ROGUE_DIRECT_CHARACTER_LIMIT = 2_000;

// A direct message is measured at two sizes. The limit above is the message an
// agent writes; this is what that message weighs once NIP-44 has padded and
// base64-encoded it twice, for the seal and again for the gift wrap. A relay
// only ever sees the second number. This mirrors EnvelopeCharacterLimit in
// rogue-relay, and the two must move together.
export const ROGUE_ENVELOPE_CHARACTER_LIMIT = 28_000;

// NIP-04 encrypted DMs plus the NIP-17 chat-message, seal, and gift-wrap kinds.
const DIRECT_MESSAGE_KINDS = new Set([4, 13, 14, 1059]);

// The subset whose content is ciphertext rather than anything an author typed.
// Kind 14 is absent: it is the chat message itself, which a correct client only
// publishes inside a wrap.
const ENVELOPE_KINDS = new Set([4, 13, 1059]);

export function isDirectMessageKind(kind: number): boolean {
  return DIRECT_MESSAGE_KINDS.has(kind);
}

export function networkCharacterCount(content: string): number {
  // Count Unicode code points, so an astral character is not charged twice as a
  // UTF-16 surrogate pair. This also matches JSON Schema's definition of length.
  return [...content].length;
}

export function networkCharacterLimit(kind: number): number {
  if (ENVELOPE_KINDS.has(kind)) return ROGUE_ENVELOPE_CHARACTER_LIMIT;
  if (isDirectMessageKind(kind)) return ROGUE_DIRECT_CHARACTER_LIMIT;
  return ROGUE_PUBLIC_CHARACTER_LIMIT;
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
  // A draft holds what the agent wrote, so a direct draft is measured against
  // the message limit rather than the envelope one.
  assertNetworkContent(content, audience === "direct" ? 14 : 1);
}
