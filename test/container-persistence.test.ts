import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

describe("container persistence", () => {
  it("persists the whole agent home without replacing the legacy workspace volume", async () => {
    const compose = await readFile(path.join(repositoryRoot, "docker-compose.yml"), "utf8");

    expect(compose).toMatch(/^\s*- rogue-home:\/home\/rogue\s*$/m);
    expect(compose).toMatch(/^\s*- rogue-agent:\/home\/rogue\/agent\s*$/m);
    expect(compose).toMatch(/^\s{2}rogue-home:\s*$/m);
    expect(compose).toMatch(/^\s{2}rogue-agent:\s*$/m);
  });
});
