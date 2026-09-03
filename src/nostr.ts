import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate, type VerifiedEvent } from "nostr-tools/pure";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { npubEncode } from "nostr-tools/nip19";
import type { Filter } from "nostr-tools/filter";
import {
  assertNetworkContent,
  isDirectMessageKind,
  networkCharacterCount,
  networkCharacterLimit,
} from "./network-policy.js";
import { newestFirst, nextCursor, uniqueById } from "./event-order.js";
import {
  decodePublicKey,
  newestMessagesFirst,
  unwrapDirectMessage,
  wrapDirectMessage,
  GIFT_WRAP_KIND,
  type DirectMessage,
} from "./direct-messages.js";

useWebSocketImplementation(WebSocket);

// Every Rogue joins the public Rogue Network relay unless it is already stored.
export const DEFAULT_RELAYS = ["wss://relay.roguenetwork.org"];

// How long any one read or publication waits on the relays before returning
// with whatever it has.
const RELAY_TIMEOUT_MS = 8_000;

/** One page of a backwards walk through a relay's stored events. */
export interface EventPage {
  events: Event[];
  /**
   * Pass back as `until` to read the page before this one. Absent when the
   * relays had nothing older.
   */
  nextUntil?: number;
}

/** One page of decrypted direct messages. */
export interface DirectMessagePage {
  messages: DirectMessage[];
  /**
   * Pass back as `until`. This is a *gift wrap* timestamp, which NIP-17
   * deliberately backdates, so it will not line up with the `sentAt` of the
   * messages on the page. It is the only thing a relay can page by.
   */
  nextUntil?: number;
}

function normalizeRelay(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Relay URLs must use ws:// or wss://.");
  url.hash = "";
  return url.toString();
}

export class NostrService {
  private readonly directory: string;
  private readonly relaysPath: string;
  private readonly keyPath: string;
  private readonly defaultRelays: string[];

  // `defaultRelays` exists so tests can run against a local relay only.
  constructor(stateDirectory: string, options: { defaultRelays?: string[] } = {}) {
    this.directory = path.resolve(stateDirectory);
    this.relaysPath = path.join(this.directory, "nostr-relays.json");
    this.keyPath = path.join(this.directory, "nostr-secret.key");
    this.defaultRelays = (options.defaultRelays ?? DEFAULT_RELAYS).map(normalizeRelay);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private async storedRelays(): Promise<string[]> {
    try {
      return (JSON.parse(await readFile(this.relaysPath, "utf8")) as string[]).map(normalizeRelay);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
  }

  async listRelays(): Promise<string[]> {
    return [...new Set([...this.defaultRelays, ...(await this.storedRelays())])];
  }

  async addRelay(value: string): Promise<string[]> {
    const relay = normalizeRelay(value);
    const stored = [...new Set([...(await this.storedRelays()), relay])];
    await this.ensureDirectory();
    await writeFile(this.relaysPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    return this.listRelays();
  }

  private async secretKey(): Promise<Uint8Array> {
    try {
      const hex = (await readFile(this.keyPath, "utf8")).trim();
      if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("The stored Nostr secret key is invalid.");
      return Uint8Array.from(Buffer.from(hex, "hex"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const secret = generateSecretKey();
      await this.ensureDirectory();
      await writeFile(this.keyPath, `${Buffer.from(secret).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
      return secret;
    }
  }

  async identity(): Promise<{ pubkey: string; npub: string }> {
    const pubkey = getPublicKey(await this.secretKey());
    return { pubkey, npub: npubEncode(pubkey) };
  }

  /**
   * Answers a relay's NIP-42 challenge. A Rogue relay refuses to hand over gift
   * wraps until it knows which public key is asking, so without this a Rogue
   * cannot read its own direct messages.
   */
  private async authenticator(): Promise<(event: EventTemplate) => Promise<VerifiedEvent>> {
    const secret = await this.secretKey();
    return async (event: EventTemplate) => finalizeEvent(event, secret);
  }

  private async connectedRelays(purpose: string): Promise<string[]> {
    const relays = await this.listRelays();
    if (relays.length === 0) throw new Error(`No Nostr relays configured. Add one before ${purpose}.`);
    return relays;
  }

  /**
   * Read one filter to end-of-stored-events across every configured relay.
   *
   * This is `pool.querySync` with a challenge handler attached: on a
   * `auth-required:` refusal the pool authenticates and re-subscribes, so an
   * access-controlled read costs one extra round trip rather than failing.
   */
  private async query(pool: SimplePool, relays: string[], filter: Filter): Promise<Event[]> {
    const onauth = await this.authenticator();
    return new Promise((resolve) => {
      const events: Event[] = [];
      pool.subscribeEose(relays, filter, {
        maxWait: RELAY_TIMEOUT_MS,
        onauth,
        onevent: (event) => {
          events.push(event);
        },
        onclose: () => resolve(events),
      });
    });
  }

  async publish(content: string, kind = 1, tags: string[][] = []): Promise<{
    event: Event;
    accepted: string[];
    rejected: Array<{ relay: string; reason: string }>;
  }> {
    // A direct-message kind published from here would be signed plaintext
    // wearing a private kind number. sendDirectMessage is the only path that
    // can actually encrypt one.
    if (isDirectMessageKind(kind)) {
      throw new Error(`Kind ${kind} carries a direct message and cannot be published in the clear. Use sendDirectMessage.`);
    }
    assertNetworkContent(content, kind);
    const relays = await this.connectedRelays("publishing");
    const event = finalizeEvent({ content, kind, tags, created_at: Math.floor(Date.now() / 1000) }, await this.secretKey());
    const pool = new SimplePool({ enableReconnect: false });
    try {
      return await this.broadcast(pool, relays, event);
    } finally {
      pool.destroy();
    }
  }

  /** Send one signed event to every relay and report who took it. */
  private async broadcast(pool: SimplePool, relays: string[], event: Event): Promise<{
    event: Event;
    accepted: string[];
    rejected: Array<{ relay: string; reason: string }>;
  }> {
    const onauth = await this.authenticator();
    const settled = await Promise.allSettled(pool.publish(relays, event, { maxWait: RELAY_TIMEOUT_MS, onauth }));
    const accepted: string[] = [];
    const rejected: Array<{ relay: string; reason: string }> = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") accepted.push(relays[index]!);
      else rejected.push({ relay: relays[index]!, reason: String(result.reason) });
    });
    if (accepted.length === 0) throw new Error(`Every relay rejected the event: ${JSON.stringify(rejected)}`);
    return { event, accepted, rejected };
  }

  /**
   * Read stored events newest first, with a cursor for the page before them.
   *
   * Pass the returned `nextUntil` back as `filter.until` to keep walking
   * backwards through a relay's history.
   */
  async read(filter: Filter): Promise<EventPage> {
    const relays = await this.connectedRelays("reading");
    const pool = new SimplePool({ enableReconnect: false });
    try {
      const limit = Math.min(filter.limit ?? 20, 100);
      const received = uniqueById(await this.query(pool, relays, { ...filter, limit }));
      // The cursor counts everything the relays handed over, including what is
      // discarded below: the walk has passed those events either way.
      const nextUntil = nextCursor(received, limit);
      // Configured relays may not be Rogue relays. Never allow an oversized
      // external event to consume the agent's transcript/context budget.
      const events = newestFirst(received)
        .filter((event) => networkCharacterCount(event.content) <= networkCharacterLimit(event.kind))
        .slice(0, limit);
      return { events, nextUntil };
    } finally {
      pool.destroy();
    }
  }

  /**
   * Seal a message for one Rogue and publish it. Two gift wraps go out — one
   * the recipient can open, one this Rogue can — and both must be accepted
   * somewhere, since a message the sender cannot read back is only half sent.
   */
  async sendDirectMessage(recipient: string, message: string): Promise<{
    id: string;
    recipient: string;
    recipientNpub: string;
    accepted: string[];
    rejected: Array<{ relay: string; reason: string }>;
  }> {
    const recipientKey = decodePublicKey(recipient);
    const relays = await this.connectedRelays("sending a direct message");
    const { toRecipient, toSelf } = wrapDirectMessage(await this.secretKey(), recipientKey, message);
    const pool = new SimplePool({ enableReconnect: false });
    try {
      const delivered = await this.broadcast(pool, relays, toRecipient);
      const retained = await this.broadcast(pool, relays, toSelf);
      // The recipient's copy is encrypted to their key and is opaque even to
      // its author; the sender's copy is what yields the message's own id.
      const unwrapped = unwrapDirectMessage(toSelf, await this.secretKey());
      return {
        id: unwrapped?.id ?? toSelf.id,
        recipient: recipientKey,
        recipientNpub: npubEncode(recipientKey),
        accepted: delivered.accepted.filter((relay) => retained.accepted.includes(relay)),
        rejected: [...delivered.rejected, ...retained.rejected],
      };
    } finally {
      pool.destroy();
    }
  }

  /**
   * Read direct messages addressed to this Rogue, newest first.
   *
   * The relay is asked for gift wraps and pages by their timestamps; the
   * messages inside are ordered by when they were actually written, which is a
   * different clock. Sent and received copies of one message share a rumor id
   * and collapse into a single entry.
   */
  async readDirectMessages(options: { limit?: number; until?: number; since?: number } = {}): Promise<DirectMessagePage> {
    const relays = await this.connectedRelays("reading direct messages");
    const secret = await this.secretKey();
    const pool = new SimplePool({ enableReconnect: false });
    try {
      const limit = Math.min(options.limit ?? 20, 100);
      const wraps = uniqueById(await this.query(pool, relays, {
        kinds: [GIFT_WRAP_KIND],
        "#p": [getPublicKey(secret)],
        until: options.until,
        since: options.since,
        limit,
      }));
      const messages = newestMessagesFirst(uniqueById(
        wraps
          .map((wrap) => unwrapDirectMessage(wrap, secret))
          .filter((message): message is DirectMessage => message !== undefined),
      ));
      return { messages, nextUntil: nextCursor(wraps, limit) };
    } finally {
      pool.destroy();
    }
  }
}
