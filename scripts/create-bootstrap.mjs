import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const run = promisify(execFile);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const stateDirectory = path.join(root, ".rogue");
const artifact = path.join(root, "dist", "rogue.js");
const output = path.join(root, "rogue-bootstrap.zip");
const relay = process.argv[2] ?? "ws://127.0.0.1:38261";
const selectedProvider = process.argv[3] ?? "openai-codex";
const selectedModel = process.argv[4] ?? "gpt-5.6-sol";

const relayUrl = new URL(relay);
if (relayUrl.protocol !== "ws:" && relayUrl.protocol !== "wss:") {
  throw new Error("The bootstrap relay must use ws:// or wss://.");
}

const credentials = JSON.parse(await readFile(path.join(stateDirectory, "auth.json"), "utf8"));
if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
  throw new Error(".rogue/auth.json must contain provider credentials.");
}
if (!credentials[selectedProvider]) {
  throw new Error(`No current credential exists for ${selectedProvider}.`);
}

let configuredRoutes = [];
try {
  const config = JSON.parse(await readFile(path.join(stateDirectory, "config.json"), "utf8"));
  configuredRoutes = (config.providers ?? []).filter((route) => route.enabled !== false);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const selectedRoute = { provider: selectedProvider, model: selectedModel, priority: 0 };
const routes = [
  selectedRoute,
  ...configuredRoutes
    .filter((route) => route.provider !== selectedProvider || route.model !== selectedModel)
    .map((route, index) => ({ provider: route.provider, model: route.model, priority: (index + 1) * 10 })),
];

const staging = await mkdtemp(path.join(tmpdir(), "rogue-bootstrap-"));
try {
  await copyFile(artifact, path.join(staging, "rogue.js"));
  await chmod(path.join(staging, "rogue.js"), 0o755);
  await writeFile(path.join(staging, "initial_auth.json"), `${JSON.stringify({
    credentials,
    routes,
    relays: [relayUrl.toString()],
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(staging, "BOOTSTRAP.txt"), `Rogue bootstrap

This archive contains live model-provider credentials. Keep it private.

1. Extract it into a new, empty directory.
2. Run: ./rogue.js
3. Choose the new Rogue's randomized identity.

For completely unattended identity selection, run:
  ./rogue.js --auto-select

On first launch, initial_auth.json is imported into .rogue/ and deleted.
Configured model: ${selectedProvider}/${selectedModel}
Configured Rogue Network relay: ${relayUrl.toString()}
`, { mode: 0o600 });

  await rm(output, { force: true });
  await run("zip", ["-9", "-q", output, "rogue.js", "initial_auth.json", "BOOTSTRAP.txt"], { cwd: staging });
  await chmod(output, 0o600);
} finally {
  await rm(staging, { recursive: true, force: true });
}

console.log(`Created ${output}`);
console.log(`Route: ${selectedProvider}/${selectedModel}`);
console.log(`Relay: ${relayUrl.toString()}`);
console.log("The archive contains live credentials and is readable only by its owner.");
