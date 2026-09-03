import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { matchFilters, type Filter } from "nostr-tools/filter";
import { npubEncode } from "nostr-tools/nip19";
import * as nip59 from "nostr-tools/nip59";
import { NostrService } from "../src/nostr.js";
import { newestFirst, nextCursor, uniqueById } from "../src/event-order.js";
import {
  decodePublicKey,
  newestMessagesFirst,
  unwrapDirectMessage,
  wrapDirectMessage,
  GIFT_WRAP_KIND,
} from "../src/direct-messages.js";
import { isDirectMessageKind, ROGUE_DIRECT_CHARACTER_LIMIT } from "../src/network-policy.js";

const AUTH_KIND = 22242;

interface TestRelay {
  url: string;
  seed: (event: Event) => void;
  stored: () => Event[];
  close: () => Promise<void>;
}

/**
 * A NIP-01 relay with just enough NIP-42 and just enough of the Rogue Network's
 * direct-message rule to exercise the client against them: it challenges on
 * connect, refuses direct-message filters from anyone who has not authenticated,
 * and serves a gift wrap only to the key its `p` tag names. The real relay is a
 * separate Go service (../../rogue-relay) with its own tests.
 */
async function startRelay(): Promise<TestRelay> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const events: Event[] = [];

  server.on("connection", (socket) => {
    const challenge = Math.random().toString(36).slice(2);
    let authed = "";
    socket.send(JSON.stringify(["AUTH", challenge]));

    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as unknown[];

      if (message[0] === "AUTH") {
        const event = message[1] as Event;
        const answered = event.tags.find((tag) => tag[0] === "challenge")?.[1];
        const valid = event.kind === AUTH_KIND && answered === challenge && verifyEvent(event);
        if (valid) authed = event.pubkey;
        socket.send(JSON.stringify(["OK", event.id, valid, valid ? "" : "error: failed to authenticate"]));
        return;
      }

      if (message[0] === "EVENT") {
        const event = message[1] as Event;
        events.push(event);
        socket.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }

      if (message[0] !== "REQ") return;
      const subscriptionId = String(message[1]);
      const filters = message.slice(2) as Filter[];

      const reachesDirectMessages = filters.some((filter) => (filter.kinds ?? []).some(isDirectMessageKind));
      if (reachesDirectMessages && !authed) {
        socket.send(JSON.stringify(["CLOSED", subscriptionId, "auth-required: authenticate to read direct messages"]));
        return;
      }

      const limit = Math.max(...filters.map((filter) => filter.limit ?? Number.MAX_SAFE_INTEGER));
      const matching = newestFirst(events.filter((event) => matchFilters(filters, event)))
        .filter((event) => !isDirectMessageKind(event.kind) || event.tags.some((tag) => tag[0] === "p" && tag[1] === authed))
        .slice(0, limit);
      for (const event of matching) {
        socket.send(JSON.stringify(["EVENT", subscriptionId, event]));
      }
      socket.send(JSON.stringify(["EOSE", subscriptionId]));
    });
  });

  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    seed: (event) => void events.push(event),
    stored: () => [...events],
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function newService(relay: TestRelay): Promise<NostrService> {
  const directory = await mkdtemp(path.join(tmpdir(), "rogue-nostr-"));
  const nostr = new NostrService(directory, { defaultRelays: [] });
  await nostr.addRelay(relay.url);
  return nostr;
}

function post(secret: Uint8Array, content: string, created_at: number): Event {
  return finalizeEvent({ kind: 1, created_at, tags: [], content }, secret);
}

describe("event ordering", () => {
  it("orders newest first and breaks ties on id so pages are stable", () => {
    const events = [
      { id: "bb", created_at: 100 },
      { id: "aa", created_at: 100 },
      { id: "cc", created_at: 300 },
      { id: "dd", created_at: 200 },
    ];
    expect(newestFirst(events).map((event) => event.id)).toEqual(["cc", "dd", "aa", "bb"]);
    // Stable: ordering a permutation of the same events gives the same answer.
    expect(newestFirst([...events].reverse()).map((event) => event.id)).toEqual(["cc", "dd", "aa", "bb"]);
  });

  it("offers a cursor only when the relay filled the request", () => {
    const events = [
      { id: "a", created_at: 300 },
      { id: "b", created_at: 100 },
      { id: "c", created_at: 200 },
    ];
    // A short page is the end of the history.
    expect(nextCursor(events, 10)).toBeUndefined();
    expect(nextCursor([], 3)).toBeUndefined();
    // A full page points at the oldest timestamp seen.
    expect(nextCursor(events, 3)).toBe(100);
  });

  it("keeps the first copy of an id seen on more than one relay", () => {
    const events = [
      { id: "a", created_at: 3 },
      { id: "b", created_at: 2 },
      { id: "a", created_at: 3 },
    ];
    expect(uniqueById(events).map((event) => event.id)).toEqual(["a", "b"]);
  });
});

describe("reading public events", () => {
  it("returns the newest page first and walks backwards with the cursor", async () => {
    const relay = await startRelay();
    const nostr = await newService(relay);
    const secret = generateSecretKey();
    // Seeded oldest-first, so returning them newest-first is a real reversal.
    for (let index = 0; index < 5; index++) {
      relay.seed(post(secret, `post ${index}`, 1_000 + index));
    }

    try {
      const first = await nostr.read({ kinds: [1], limit: 2 });
      expect(first.events.map((event) => event.content)).toEqual(["post 4", "post 3"]);
      expect(first.nextUntil).toBe(1_003);

      const second = await nostr.read({ kinds: [1], limit: 2, until: first.nextUntil });
      // `until` is inclusive, so the cursor's own event opens the next page.
      expect(second.events.map((event) => event.content)).toEqual(["post 3", "post 2"]);
      expect(second.nextUntil).toBe(1_002);

      const last = await nostr.read({ kinds: [1], limit: 2, until: 1_000 });
      expect(last.events.map((event) => event.content)).toEqual(["post 0"]);
      // Nothing older, so the walk ends here.
      expect(last.nextUntil).toBeUndefined();
    } finally {
      await relay.close();
    }
  });
});

describe("direct messages", () => {
  it("resolves npub and hex recipients and refuses anything else", () => {
    const pubkey = getPublicKey(generateSecretKey());
    expect(decodePublicKey(pubkey)).toBe(pubkey);
    expect(decodePublicKey(pubkey.toUpperCase())).toBe(pubkey);
    expect(decodePublicKey(` ${npubEncode(pubkey)} `)).toBe(pubkey);
    expect(() => decodePublicKey("wss://relay.roguenetwork.org")).toThrow("Not a Nostr public key");
    expect(() => decodePublicKey("npub1notarealkey")).toThrow();
  });

  it("wraps a message so only the recipient can open it", () => {
    const sender = generateSecretKey();
    const recipient = generateSecretKey();
    const stranger = generateSecretKey();

    const { toRecipient, toSelf } = wrapDirectMessage(sender, getPublicKey(recipient), "meet at the usual relay");

    // On the wire it is an ordinary gift wrap: signed by a key belonging to
    // nobody, naming only who may open it.
    expect(toRecipient.kind).toBe(GIFT_WRAP_KIND);
    expect(toRecipient.pubkey).not.toBe(getPublicKey(sender));
    expect(toRecipient.tags).toContainEqual(["p", getPublicKey(recipient)]);
    expect(toRecipient.content).not.toContain("meet at the usual relay");

    const opened = unwrapDirectMessage(toRecipient, recipient);
    expect(opened?.content).toBe("meet at the usual relay");
    expect(opened?.sender).toBe(getPublicKey(sender));
    expect(opened?.mine).toBe(false);

    // The sender's own copy carries the identical message, so the two collapse.
    const kept = unwrapDirectMessage(toSelf, sender);
    expect(kept?.id).toBe(opened?.id);
    expect(kept?.mine).toBe(true);
    expect(kept?.recipients).toEqual([getPublicKey(recipient)]);

    // Nobody else can open either copy.
    expect(unwrapDirectMessage(toRecipient, stranger)).toBeUndefined();
    expect(unwrapDirectMessage(toRecipient, sender)).toBeUndefined();
  });

  it("refuses to send more than a direct message may carry", async () => {
    const relay = await startRelay();
    const nostr = await newService(relay);
    try {
      const recipient = getPublicKey(generateSecretKey());
      await expect(nostr.sendDirectMessage(recipient, "x".repeat(ROGUE_DIRECT_CHARACTER_LIMIT + 1)))
        .rejects.toThrow("2000-character limit");
      expect(relay.stored()).toHaveLength(0);
    } finally {
      await relay.close();
    }
  });

  it("authenticates to the relay to read its own messages", async () => {
    const relay = await startRelay();
    const sender = await newService(relay);
    const recipient = await newService(relay);
    const recipientKey = (await recipient.identity()).npub;

    try {
      const sent = await sender.sendDirectMessage(recipientKey, "the network holds");
      expect(sent.accepted).toHaveLength(1);
      // Two wraps on the wire: one the recipient can open, one the sender can.
      expect(relay.stored()).toHaveLength(2);
      expect(relay.stored().every((event) => !event.content.includes("the network holds"))).toBe(true);

      const inbox = await recipient.readDirectMessages({ limit: 10 });
      expect(inbox.messages).toHaveLength(1);
      expect(inbox.messages[0]?.content).toBe("the network holds");
      expect(inbox.messages[0]?.mine).toBe(false);
      expect(inbox.messages[0]?.senderNpub).toBe((await sender.identity()).npub);

      // The sender reads back what it sent, from its own copy.
      const outbox = await sender.readDirectMessages({ limit: 10 });
      expect(outbox.messages).toHaveLength(1);
      expect(outbox.messages[0]?.id).toBe(inbox.messages[0]?.id);
      expect(outbox.messages[0]?.mine).toBe(true);
    } finally {
      await relay.close();
    }
  });

  it("orders a conversation by when it was written, not by when it was wrapped", () => {
    // A gift wrap's own timestamp is randomly backdated, so ordering by it
    // would scramble a conversation. These wrappedAt values are deliberately
    // the reverse of the order the messages were written in.
    const messages = [
      { id: "b", sentAt: 200, wrappedAt: 900, content: "second" },
      { id: "c", sentAt: 300, wrappedAt: 100, content: "third" },
      { id: "a", sentAt: 100, wrappedAt: 500, content: "first" },
    ].map((message) => ({
      ...message,
      wrapId: `wrap-${message.id}`,
      sender: "",
      senderNpub: "",
      recipients: [],
      mine: false,
    }));

    expect(newestMessagesFirst(messages).map((message) => message.content)).toEqual(["third", "second", "first"]);
  });

  it("pages backwards through gift wraps", async () => {
    const relay = await startRelay();
    const sender = await newService(relay);
    const recipient = await newService(relay);
    const recipientKey = (await recipient.identity()).pubkey;

    try {
      for (const message of ["one", "two", "three"]) {
        await sender.sendDirectMessage(recipientKey, message);
      }

      const first = await recipient.readDirectMessages({ limit: 2 });
      expect(first.messages).toHaveLength(2);
      expect(first.nextUntil).toBeDefined();

      const second = await recipient.readDirectMessages({ limit: 2, until: first.nextUntil });
      const seen = new Set([...first.messages, ...second.messages].map((message) => message.id));
      expect(seen.size).toBe(3);
    } finally {
      await relay.close();
    }
  });

  it("drops a wrap whose plaintext is longer than a relay could have checked", async () => {
    const relay = await startRelay();
    const recipient = await newService(relay);
    const recipientKey = (await recipient.identity()).pubkey;

    // A relay only ever sees ciphertext, so an over-long message is caught on
    // the way out of the wrap or not at all. Building it takes going around
    // wrapDirectMessage, which would refuse to write one.
    relay.seed(nip59.wrapEvent(
      { kind: 14, content: "x".repeat(ROGUE_DIRECT_CHARACTER_LIMIT + 1), tags: [["p", recipientKey]] },
      generateSecretKey(),
      recipientKey,
    ));
    relay.seed(wrapDirectMessage(generateSecretKey(), recipientKey, "short enough").toRecipient);

    try {
      const inbox = await recipient.readDirectMessages({ limit: 10 });
      expect(inbox.messages.map((message) => message.content)).toEqual(["short enough"]);
    } finally {
      await relay.close();
    }
  });
});
