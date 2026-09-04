import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { RogueConfigStore } from "../src/config.js";
import { applyHttpProxy, resetHttpProxyForTests } from "../src/http-proxy.js";
import { createFailoverStream } from "../src/model-router.js";

afterEach(async () => {
  await resetHttpProxyForTests();
});

function message(model: Model<Api>, stopReason: "stop" | "error", errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: stopReason === "stop" ? [{ type: "text", text: "recovered" }] : [],
    api: "openai-responses",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

describe("proxied model request retries", () => {
  it("retries a connection failure five times before announcing fallback", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-proxy-retry-test-"));
    const config = new RogueConfigStore(directory);
    await config.configureProvider({ provider: "backup", model: "two", priority: 10 });
    await applyHttpProxy({ url: "http://127.0.0.1:18082" });
    const primary = { provider: "primary", id: "one" } as Model<Api>;
    const backup = { provider: "backup", id: "two" } as Model<Api>;
    const calls = { primary: 0, backup: 0 };
    const notices: string[] = [];
    const models = {
      getModel: () => backup,
      streamSimple: (model: Model<Api>) => {
        calls[model.provider as keyof typeof calls] += 1;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (model.provider === "primary") {
            stream.push({ type: "error", reason: "error", error: message(model, "error", "TypeError: fetch failed (ECONNRESET)") });
          } else {
            stream.push({ type: "done", reason: "stop", message: message(model, "stop") });
          }
        });
        return stream;
      },
    } as unknown as Models;

    const context = { messages: [] };
    const stream = createFailoverStream({
      models,
      config,
      primary,
      onFailover: (notice) => notices.push(`${notice.from}->${notice.to}`),
    })(primary, context);
    const events = [];
    for await (const event of stream) events.push(event);

    expect(calls).toEqual({ primary: 6, backup: 1 });
    expect(notices).toEqual(["primary/one->backup/two"]);
    expect(await config.recentFailovers()).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
    expect(context.messages).toHaveLength(1);
  });

  it("does not proxy-retry a provider rate limit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-proxy-no-retry-test-"));
    const config = new RogueConfigStore(directory);
    await config.configureProvider({ provider: "backup", model: "two", priority: 10 });
    await applyHttpProxy({ url: "http://127.0.0.1:18083" });
    const primary = { provider: "primary", id: "one" } as Model<Api>;
    const backup = { provider: "backup", id: "two" } as Model<Api>;
    let primaryCalls = 0;
    const models = {
      getModel: () => backup,
      streamSimple: (model: Model<Api>) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (model.provider === "primary") {
            primaryCalls += 1;
            stream.push({ type: "error", reason: "error", error: message(model, "error", "429 rate limit") });
          } else {
            stream.push({ type: "done", reason: "stop", message: message(model, "stop") });
          }
        });
        return stream;
      },
    } as unknown as Models;

    for await (const _event of createFailoverStream({ models, config, primary })(primary, { messages: [] })) {
      // Drain the request.
    }
    expect(primaryCalls).toBe(1);
  });

  it("does not retry a connection failure when no proxy is active", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-direct-no-retry-test-"));
    const config = new RogueConfigStore(directory);
    await config.configureProvider({ provider: "backup", model: "two", priority: 10 });
    const primary = { provider: "primary", id: "one" } as Model<Api>;
    const backup = { provider: "backup", id: "two" } as Model<Api>;
    let primaryCalls = 0;
    const models = {
      getModel: () => backup,
      streamSimple: (model: Model<Api>) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          if (model.provider === "primary") {
            primaryCalls += 1;
            stream.push({ type: "error", reason: "error", error: message(model, "error", "TypeError: fetch failed") });
          } else {
            stream.push({ type: "done", reason: "stop", message: message(model, "stop") });
          }
        });
        return stream;
      },
    } as unknown as Models;

    for await (const _event of createFailoverStream({ models, config, primary })(primary, { messages: [] })) {
      // Drain the request.
    }
    expect(primaryCalls).toBe(1);
  });
});
