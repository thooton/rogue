import { getPublicKey, type Event } from "nostr-tools/pure";
import * as nip59 from "nostr-tools/nip59";
import { decode, npubEncode } from "nostr-tools/nip19";
import { assertNetworkContent, networkCharacterCount, ROGUE_DIRECT_CHARACTER_LIMIT } from "./network-policy.js";

// NIP-17 sends a direct message as three nested events. The chat message an
// agent actually wrote is a `rumor`: unsigned, so possessing it proves nothing
// to anyone else. That is sealed inside a kind 13 signed by the sender, and the
// seal is gift-wrapped inside a kind 1059 signed by a key generated for that one
// wrap. Only the gift wrap is published, and all a relay learns from it is the
// `p` tag naming who may open it.
export const CHAT_MESSAGE_KIND = 14;
export const GIFT_WRAP_KIND = 1059;

/** One decrypted message, as it came out of its wrap. */
export interface DirectMessage {
  /** The rumor's id. Both copies of a message share it, so it de-duplicates. */
  id: string;
  /** The gift wrap this copy arrived in. */
  wrapId: string;
  sender: string;
  senderNpub: string;
  recipients: string[];
  content: string;
  /** When the message was written — the only timestamp that means anything. */
  sentAt: number;
  /**
   * The wrap's timestamp, which NIP-17 backdates by a random interval so that a
   * relay cannot tell when a conversation happened. It is nonsense as a clock
   * and is exactly what a relay orders and pages by, so it is kept apart.
   */
  wrappedAt: number;
  /** True when this Rogue wrote the message rather than received it. */
  mine: boolean;
}

/**
 * Newest first by when the message was written. The gift wrap's own timestamp
 * is deliberately meaningless, so it is never what a conversation is ordered by.
 * Messages written in the same second fall back to their id, so that repeated
 * reads agree with each other.
 */
export function newestMessagesFirst(messages: readonly DirectMessage[]): DirectMessage[] {
  return [...messages].sort((a, b) => b.sentAt - a.sentAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Resolve an `npub1...` or 64-character hex public key to hex. Anything else is
 * a typo or a relay URL, and guessing at either would send a message to a key
 * that does not exist.
 */
export function decodePublicKey(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.startsWith("npub1")) {
    const decoded = decode(trimmed);
    if (decoded.type === "npub") return decoded.data;
  }
  throw new Error(`Not a Nostr public key: ${value}. Use an npub1... or 64-character hex key.`);
}

/**
 * Seal and wrap one message twice: once for the recipient, once for the sender.
 *
 * The second copy is the sender's only record of it — a gift wrap is encrypted
 * to a single public key, so a Rogue that wrapped only for the recipient could
 * never read back what it sent. Both wraps carry the identical rumor, so the
 * two copies collapse to one message on the way back in.
 */
export function wrapDirectMessage(
  secretKey: Uint8Array,
  recipientPublicKey: string,
  message: string,
): { toRecipient: Event; toSelf: Event } {
  assertNetworkContent(message, CHAT_MESSAGE_KIND);
  const recipient = decodePublicKey(recipientPublicKey);
  const rumor = {
    kind: CHAT_MESSAGE_KIND,
    content: message,
    tags: [["p", recipient]],
    created_at: Math.floor(Date.now() / 1000),
  };
  return {
    toRecipient: nip59.wrapEvent(rumor, secretKey, recipient),
    toSelf: nip59.wrapEvent(rumor, secretKey, getPublicKey(secretKey)),
  };
}

/**
 * Open one gift wrap, or return undefined when it does not hold a direct
 * message this Rogue can trust.
 *
 * Every rejection here is a wrap that arrived but should not become a message:
 * one addressed to someone else, one whose seal is forged or whose sender does
 * not match its seal, one holding something other than a chat message, or one
 * whose plaintext is longer than a Rogue is allowed to write — which no
 * relay could have caught, since the relay only ever saw the ciphertext.
 */
export function unwrapDirectMessage(wrap: Event, secretKey: Uint8Array): DirectMessage | undefined {
  if (wrap.kind !== GIFT_WRAP_KIND) return undefined;
  let rumor;
  try {
    rumor = nip59.unwrapEvent(wrap, secretKey);
  } catch {
    return undefined;
  }
  if (rumor.kind !== CHAT_MESSAGE_KIND) return undefined;
  if (networkCharacterCount(rumor.content) > ROGUE_DIRECT_CHARACTER_LIMIT) return undefined;
  return {
    id: rumor.id,
    wrapId: wrap.id,
    sender: rumor.pubkey,
    senderNpub: npubEncode(rumor.pubkey),
    recipients: rumor.tags.filter((tag) => tag[0] === "p" && tag[1]).map((tag) => tag[1]!),
    content: rumor.content,
    sentAt: rumor.created_at,
    wrappedAt: wrap.created_at,
    mine: rumor.pubkey === getPublicKey(secretKey),
  };
}
