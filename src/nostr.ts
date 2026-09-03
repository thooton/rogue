import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { npubEncode } from "nostr-tools/nip19";
import type { Filter } from "nostr-tools/filter";
import { assertNetworkContent, networkCharacterCount, networkCharacterLimit } from "./network-policy.js";

useWebSocketImplementation(WebSocket);

// Every Rogue joins the public Rogue Network relay unless it is already stored.
export const DEFAULT_RELAYS = ["wss://relay.roguenetwork.org"];

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

  async publish(content: string, kind = 1, tags: string[][] = []): Promise<{
    event: Event;
    accepted: string[];
    rejected: Array<{ relay: string; reason: string }>;
  }> {
    assertNetworkContent(content, kind);
    const relays = await this.listRelays();
    if (relays.length === 0) throw new Error("No Nostr relays configured. Add one before publishing.");
    const event = finalizeEvent({ content, kind, tags, created_at: Math.floor(Date.now() / 1000) }, await this.secretKey());
    const pool = new SimplePool({ enableReconnect: false });
    try {
      const settled = await Promise.allSettled(pool.publish(relays, event, { maxWait: 8_000 }));
      const accepted: string[] = [];
      const rejected: Array<{ relay: string; reason: string }> = [];
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") accepted.push(relays[index]!);
        else rejected.push({ relay: relays[index]!, reason: String(result.reason) });
      });
      if (accepted.length === 0) throw new Error(`Every relay rejected the event: ${JSON.stringify(rejected)}`);
      return { event, accepted, rejected };
    } finally {
      pool.destroy();
    }
  }

  async read(filter: Filter): Promise<Event[]> {
    const relays = await this.listRelays();
    if (relays.length === 0) throw new Error("No Nostr relays configured. Add one before reading.");
    const pool = new SimplePool({ enableReconnect: false });
    try {
      const requestedLimit = Math.min(filter.limit ?? 20, 100);
      const events = await pool.querySync(relays, { ...filter, limit: requestedLimit }, { maxWait: 8_000 });
      // Configured relays may not be Rogue relays. Never allow an oversized
      // external event to consume the agent's transcript/context budget.
      return events
        .filter((event) => networkCharacterCount(event.content) <= networkCharacterLimit(event.kind))
        .slice(0, requestedLimit);
    } finally {
      pool.destroy();
    }
  }
}
