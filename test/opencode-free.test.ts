import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Context, FetchFunction, ProviderHeaders } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { RogueConfigStore } from "../src/config.js";
import { FileCredentialStore } from "../src/credentials.js";
import { importInitialAuthentication } from "../src/initial-auth.js";
import { isFreeOpenCodeModel, openCodeFreeHeaders, rotateOpenCodeFreeIdentity } from "../src/opencode-free.js";
import { createRogueModels } from "../src/provider-runtime.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function testContext(): Context {
  return {
    systemPrompt: "You are a test assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }], timestamp: Date.now() }],
    tools: [],
  };
}

function successfulStream(): Response {
  const events = [
    { id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "big-pickle", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] },
    { id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "big-pickle", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function drain(stream: AsyncIterable<{ type: string; error?: { errorMessage?: string } }>): Promise<void> {
  for await (const event of stream) {
    if (event.type === "error") throw new Error(event.error?.errorMessage ?? "OpenCode stream failed");
  }
}

describe("OpenCode free models", () => {
  it("makes every zero-cost OpenCode model available without storing an API key", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-opencode-free-test-"));
    const { models, credentials } = await createRogueModels(directory);
    const available = await models.getAvailable("opencode");

    expect(available.map((model) => model.id)).toContain("big-pickle");
    expect(available.length).toBeGreaterThan(1);
    expect(available.every(isFreeOpenCodeModel)).toBe(true);
    await expect(credentials.list()).resolves.toEqual([]);
  });

  it("keeps OpenCode cache-affinity IDs stable, rotates request IDs, and sends no bearer token", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-opencode-headers-test-"));
    const { models, credentials } = await createRogueModels(directory);
    // Free requests must use the anonymous protocol even when a paid-model key
    // is configured for the same provider.
    await credentials.modify("opencode", async () => ({ type: "api_key", key: "paid-model-key" }));
    const model = models.getModel("opencode", "big-pickle")!;
    const requests: Headers[] = [];
    const fetch: FetchFunction = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request.headers);
      return successfulStream();
    };

    const requestOptions = { fetch, maxTokens: 64, cacheRetention: "none" as const, sessionId: "rogue-test-profile" };
    await drain(models.streamSimple(model, testContext(), requestOptions));
    await drain(models.streamSimple(model, testContext(), requestOptions));

    expect(requests).toHaveLength(2);
    for (const headers of requests) {
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("user-agent")).toBe("opencode/1.0.0");
      expect(headers.get("x-opencode-client")).toBe("opencode");
      expect(headers.get("x-opencode-project")).toMatch(UUID);
      expect(headers.get("x-opencode-session")).toMatch(UUID);
      expect(headers.get("x-opencode-request")).toMatch(UUID);
    }
    expect(requests[0]!.get("x-opencode-project")).toBe(requests[1]!.get("x-opencode-project"));
    expect(requests[0]!.get("x-opencode-session")).toBe(requests[1]!.get("x-opencode-session"));
    expect(requests[0]!.get("x-opencode-request")).not.toBe(requests[1]!.get("x-opencode-request"));
  });

  it("retains normal API-key access to paid OpenCode models", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-opencode-paid-test-"));
    const { models, credentials } = await createRogueModels(directory);
    const paid = models.getModels("opencode").find((model) => !isFreeOpenCodeModel(model))!;

    expect((await models.getAvailable("opencode")).some((model) => model.id === paid.id)).toBe(false);
    await credentials.modify("opencode", async () => ({ type: "api_key", key: "paid-model-key" }));
    expect((await models.getAvailable("opencode")).some((model) => model.id === paid.id)).toBe(true);
    await expect(models.getAuth(paid)).resolves.toMatchObject({ auth: { apiKey: "paid-model-key" } });
  });

  it("accepts a keyless Big Pickle route in initial_auth.json", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-opencode-bootstrap-test-"));
    const bootstrap = path.join(directory, "initial_auth.json");
    await writeFile(bootstrap, JSON.stringify({ providers: [{ provider: "opencode", model: "big-pickle" }] }));

    await expect(importInitialAuthentication(directory, bootstrap)).resolves.toBe(true);
    await expect(new RogueConfigStore(directory).listProviders()).resolves.toEqual([
      { provider: "opencode", model: "big-pickle", priority: 0, enabled: true },
    ]);
    await expect(new FileCredentialStore(path.join(directory, "auth.json")).list()).resolves.toEqual([]);
  });

  it("builds four distinct identifiers for one anonymous request", () => {
    const headers: ProviderHeaders = openCodeFreeHeaders("rogue-test-profile");
    const identifiers = [headers["x-opencode-project"], headers["x-opencode-session"], headers["x-opencode-request"]];
    expect(new Set(identifiers).size).toBe(3);
  });

  it("derives the same affinity IDs across calls for the same durable Rogue session", () => {
    const first = openCodeFreeHeaders("rogue-test-profile");
    const second = openCodeFreeHeaders("rogue-test-profile");
    const other = openCodeFreeHeaders("rogue-other-profile");

    expect(second["x-opencode-project"]).toBe(first["x-opencode-project"]);
    expect(second["x-opencode-session"]).toBe(first["x-opencode-session"]);
    expect(second["x-opencode-request"]).not.toBe(first["x-opencode-request"]);
    expect(other["x-opencode-project"]).not.toBe(first["x-opencode-project"]);
    expect(other["x-opencode-session"]).not.toBe(first["x-opencode-session"]);
  });

  it("rotates the complete OpenCode identity while retaining the new identity for later calls", () => {
    const sessionId = `rogue-rate-limited-${crypto.randomUUID()}`;
    const first = openCodeFreeHeaders(sessionId);

    rotateOpenCodeFreeIdentity(sessionId);
    const rotated = openCodeFreeHeaders(sessionId);
    const retained = openCodeFreeHeaders(sessionId);

    expect(rotated["x-opencode-project"]).not.toBe(first["x-opencode-project"]);
    expect(rotated["x-opencode-session"]).not.toBe(first["x-opencode-session"]);
    expect(rotated["x-opencode-request"]).not.toBe(first["x-opencode-request"]);
    expect(retained["x-opencode-project"]).toBe(rotated["x-opencode-project"]);
    expect(retained["x-opencode-session"]).toBe(rotated["x-opencode-session"]);
    expect(retained["x-opencode-request"]).not.toBe(rotated["x-opencode-request"]);
  });
});
