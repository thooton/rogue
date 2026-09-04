import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RogueConfigStore } from "../src/config.js";
import {
  applyHttpProxy,
  httpProxyStatus,
  normalizeHttpProxySettings,
  redactHttpProxyUrl,
  resetHttpProxyForTests,
} from "../src/http-proxy.js";
import { redactedJson } from "../src/redaction.js";
import { RogueStore } from "../src/store.js";
import { createRogueTools } from "../src/tools.js";
import { importInitialAuthentication } from "../src/initial-auth.js";

afterEach(async () => {
  await resetHttpProxyForTests();
});

describe("HTTP proxy configuration", () => {
  it("validates HTTP(S) proxies and redacts embedded credentials", () => {
    expect(normalizeHttpProxySettings("http://proxy.example:8080")).toEqual({ url: "http://proxy.example:8080/" });
    expect(normalizeHttpProxySettings({ url: "https://user:pass@proxy.example:8443", noProxy: "localhost,.internal" }))
      .toEqual({ url: "https://user:pass@proxy.example:8443/", noProxy: "localhost,.internal" });
    expect(redactHttpProxyUrl("http://user:pass@proxy.example:8080")).toBe("http://redacted:redacted@proxy.example:8080/");
    expect(redactedJson({ proxyUrl: "http://user:pass@proxy.example" })).not.toContain("user:pass");
    expect(() => normalizeHttpProxySettings("http://user:secret@[")).toThrow("The HTTP proxy URL is invalid.");
    try {
      normalizeHttpProxySettings("http://user:secret@[");
    } catch (error) {
      expect(String(error)).not.toContain("user:secret");
    }
    expect(() => normalizeHttpProxySettings("socks5://proxy.example:1080")).toThrow(/SOCKS and PAC/);
  });

  it("persists, reports, changes, and removes proxy settings through model tools", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-http-proxy-tools-test-"));
    const store = new RogueStore(directory);
    const config = new RogueConfigStore(directory);
    const tools = createRogueTools(store, { config });
    const configure = tools.find((tool) => tool.name === "configure_http_proxy")!;
    const inspect = tools.find((tool) => tool.name === "get_http_proxy")!;
    const remove = tools.find((tool) => tool.name === "remove_http_proxy")!;

    const configured = await configure.execute("proxy-set", {
      proxyUrl: "http://agent:secret@127.0.0.1:18080",
      noProxy: "localhost",
    });
    expect(JSON.stringify(configured)).not.toContain("agent:secret");
    await expect(config.getHttpProxy()).resolves.toEqual({
      url: "http://agent:secret@127.0.0.1:18080/",
      noProxy: "localhost",
    });

    const reported = await inspect.execute("proxy-get", {});
    expect(JSON.stringify(reported)).not.toContain("agent:secret");
    expect(JSON.stringify(reported)).toContain("redacted:redacted");

    await remove.execute("proxy-remove", {});
    await expect(config.getHttpProxy()).resolves.toBeUndefined();
  });

  it("imports a proxy before validating a keyless initial model route", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rogue-http-proxy-bootstrap-test-"));
    const bootstrap = path.join(directory, "initial_auth.json");
    await writeFile(bootstrap, JSON.stringify({
      httpProxy: { url: "http://bootstrap:secret@127.0.0.1:18081", noProxy: "localhost" },
      providers: [{ provider: "opencode", model: "big-pickle" }],
    }));

    await expect(importInitialAuthentication(directory, bootstrap)).resolves.toBe(true);
    await expect(new RogueConfigStore(directory).getHttpProxy()).resolves.toEqual({
      url: "http://bootstrap:secret@127.0.0.1:18081/",
      noProxy: "localhost",
    });
  });

  it("routes global fetch through an authenticated proxy and honors NO_PROXY", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ reached: true }));
    });
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const targetPort = (target.address() as AddressInfo).port;

    let proxyHits = 0;
    let proxyRequestUrl: string | undefined;
    let proxyAuthorization: string | undefined;
    const tunnelSockets = new Set<Duplex>();
    const proxy = createServer((request, response) => {
      proxyHits += 1;
      proxyRequestUrl = request.url;
      proxyAuthorization = request.headers["proxy-authorization"];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ reached: true }));
    });
    proxy.on("connect", (request, client, head) => {
      tunnelSockets.add(client);
      client.once("close", () => tunnelSockets.delete(client));
      proxyHits += 1;
      proxyAuthorization = request.headers["proxy-authorization"];
      const [hostname, rawPort] = (request.url ?? "").split(":");
      const upstream = connect(Number(rawPort), hostname, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      tunnelSockets.add(upstream);
      upstream.once("close", () => tunnelSockets.delete(upstream));
      upstream.on("error", () => client.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as AddressInfo).port;
    const proxyUrl = `http://proxy-user:proxy-pass@127.0.0.1:${proxyPort}`;

    try {
      await applyHttpProxy({ url: proxyUrl });
      await expect((await fetch(`http://127.0.0.1:${targetPort}/proxied`)).json()).resolves.toEqual({ reached: true });
      expect(proxyHits).toBe(1);
      expect(proxyRequestUrl).toBe(`http://127.0.0.1:${targetPort}/proxied`);
      expect(proxyAuthorization).toBe(`Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`);

      await applyHttpProxy({ url: proxyUrl, noProxy: "127.0.0.1" });
      await expect((await fetch(`http://127.0.0.1:${targetPort}/direct`)).json()).resolves.toEqual({ reached: true });
      expect(proxyHits).toBe(1);
      expect(httpProxyStatus({ url: proxyUrl }).source).toBe("stored");
    } finally {
      await resetHttpProxyForTests();
      for (const socket of tunnelSockets) socket.destroy();
      target.closeAllConnections();
      proxy.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => target.close(() => resolve())),
        new Promise<void>((resolve) => proxy.close(() => resolve())),
      ]);
    }
  });
});
