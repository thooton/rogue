#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createRogueAgent } from "./agent.js";
import { PersonaDatabase, type ProfileCandidate } from "./personas.js";
import { runApiKeySetup, runAuthentication, runProviderSetup } from "./auth.js";
import { startIntrospectionServer } from "./introspection.js";
import { NostrService } from "./nostr.js";
import {
  buildAutonomousCyclePrompt,
  runAutonomousLoop,
  type AutonomousCycleResult,
} from "./autonomy.js";
import { verifyBundledProviderRuntime } from "./provider-runtime.js";
import { MAX_WAKEUP_INTERVAL_SECONDS, RogueConfigStore } from "./config.js";
import { importInitialAuthentication } from "./initial-auth.js";
import * as ui from "./ui.js";

interface CliOptions {
  provider?: string;
  model?: string;
  stateDirectory?: string;
  thinkingLevel?: ThinkingLevel;
  prompt?: string;
  interactive: boolean;
  intervalSeconds?: number;
  maxCycles?: number;
  autoSelectPersona: boolean;
  authenticate: boolean;
  authProvider?: string;
  apiKeyProvider?: string;
  inspectHost: string;
  nostrRelays: string[];
  allowFailover: boolean;
  help: boolean;
  selfCheck: boolean;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function usage(): string {
  return `Rogue — autonomous, database-defined agents powered by Pi

Usage:
  npm run dev -- [options] [prompt]
  npm run start -- [options] [prompt]

Options:
  --provider <id>    Use or preselect a provider
  --model <id>       Use or preselect a model
  --state-dir <path> Durable state directory (default: .rogue)
  --thinking <level> off|minimal|low|medium|high|xhigh|max
  --interactive      Start the supervised chat interface
  --interval <sec>   Persist wakeup delay, 0-${MAX_WAKEUP_INTERVAL_SECONDS}s (initial default: 300)
  --max-cycles <n>   Stop after n attempted cycles (default: unlimited)
  --auto-select      Select the first generated persona without prompting
  --auth [provider]  Browse providers, authenticate, choose models, and exit
  --api-key <id>     Run a provider's API credential setup and choose a model
  --inspect-host <ip> Transcript server bind address (default: 127.0.0.1)
  --nostr-relay <url> Persist a starter relay URL (repeatable)
  --no-failover      Pin --provider/--model and never fall back to another route
  --self-check       Verify bundled provider modules without network access
  -h, --help         Show this help

Without a prompt, Rogue runs autonomously until stopped. A positional prompt runs
once and exits. Credentials and fallback routes are loaded from Rogue's private
state directory.`;
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    selfCheck: false,
    interactive: false,
    autoSelectPersona: false,
    authenticate: false,
    inspectHost: "127.0.0.1",
    nostrRelays: [],
    allowFailover: true,
  };
  const prompt: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--self-check") options.selfCheck = true;
    else if (arg === "--provider") options.provider = takeValue(args, index++, arg);
    else if (arg === "--model") options.model = takeValue(args, index++, arg);
    else if (arg === "--state-dir") options.stateDirectory = takeValue(args, index++, arg);
    else if (arg === "--interactive") options.interactive = true;
    else if (arg === "--auto-select") options.autoSelectPersona = true;
    else if (arg === "--auth") {
      options.authenticate = true;
      const provider = args[index + 1];
      if (provider && !provider.startsWith("-")) options.authProvider = args[++index];
    } else if (arg === "--api-key") {
      options.apiKeyProvider = takeValue(args, index++, arg);
    } else if (arg === "--inspect-host") options.inspectHost = takeValue(args, index++, arg);
    else if (arg === "--nostr-relay") options.nostrRelays.push(takeValue(args, index++, arg));
    else if (arg === "--no-failover") options.allowFailover = false;
    else if (arg === "--interval") {
      const value = Number(takeValue(args, index++, arg));
      if (!Number.isFinite(value) || value < 0 || value > MAX_WAKEUP_INTERVAL_SECONDS) throw new Error(`Invalid interval: ${value}`);
      options.intervalSeconds = value;
    } else if (arg === "--max-cycles") {
      const value = Number(takeValue(args, index++, arg));
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid max cycles: ${value}`);
      options.maxCycles = value;
    } else if (arg === "--thinking") {
      const value = takeValue(args, index++, arg);
      if (!THINKING_LEVELS.has(value)) throw new Error(`Invalid thinking level: ${value}`);
      options.thinkingLevel = value as ThinkingLevel;
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else prompt.push(arg);
  }
  if (prompt.length) options.prompt = prompt.join(" ");
  if (options.interactive && options.prompt) throw new Error("--interactive cannot be combined with a prompt.");
  if (options.authenticate && (options.interactive || options.prompt)) {
    throw new Error("--auth cannot be combined with interactive mode or a prompt.");
  }
  if (options.apiKeyProvider && (options.authenticate || options.interactive || options.prompt)) {
    throw new Error("--api-key cannot be combined with another operating mode.");
  }
  return options;
}

const SETUP_STEPS = ["Identity", "Model", "Network"] as const;

function candidateChoice(candidate: ProfileCandidate, index: number): ui.SelectItem {
  const { fourFactors: factors, typeCode, typeTitle } = candidate.personality;
  const emblem = ui.flag(candidate.countryCode);
  return {
    id: String(index),
    label: `${emblem ? `${emblem}  ` : ""}${candidate.name}${ui.style.faint(` · ${candidate.country}`)}`,
    badge: typeCode,
    // Several seeded personas are literally named after their type, so the
    // type title is only appended when it adds something.
    description: candidate.personaLabel.includes(typeTitle)
      ? candidate.personaLabel
      : `${candidate.personaLabel} · The ${typeTitle}`,
    detail: [
      candidate.personaDescription,
      `${factors.energy} · ${factors.information} · ${factors.decisions} · ${factors.lifestyle}`,
      `Traits: ${candidate.traits.join(", ")}`,
    ],
    searchText: `${candidate.country} ${typeTitle} ${candidate.traits.join(" ")} ${candidate.personaDescription}`,
  };
}

async function ensureActiveProfile(options: CliOptions): Promise<boolean> {
  const stateDirectory = options.stateDirectory ?? ".rogue";
  const personas = await PersonaDatabase.open(stateDirectory);
  try {
    if (personas.getAgentProfile()) return false;
    const candidates = personas.generateCandidates(4);

    ui.logo("first run · this identity is permanent");
    ui.steps(SETUP_STEPS, 0);

    let selected = 0;
    let createdBy = "automatic-onboarding";
    if (!options.autoSelectPersona) {
      createdBy = "human-onboarding";
      const choice = await ui.select({
        title: "Choose this Rogue agent's identity",
        subtitle: "Country, name, and persona are randomized. The choice is stored immutably.",
        confirmLabel: "Identity",
        items: candidates.map(candidateChoice),
      });
      selected = Number(choice.id);
    } else {
      ui.heading("Identity", "Auto-selecting the first generated candidate.");
    }
    const profile = personas.createAgent(candidates[selected]!, { createdBy });
    ui.panel("Agent identity", [
      ["Name", profile.name],
      ["Country", `${ui.flag(profile.countryCode)} ${profile.country}`.trim()],
      ["Persona", profile.personaLabel],
      ["Personality", `${profile.personality.typeCode} · The ${profile.personality.typeTitle}`],
      ["Traits", profile.traits.join(", ")],
    ]);
    return true;
  } finally {
    personas.close();
  }
}

async function configureInitialRelays(options: CliOptions): Promise<void> {
  if (!stdin.isTTY || options.autoSelectPersona) return;
  const nostr = new NostrService(options.stateDirectory ?? ".rogue");
  let relays = await nostr.listRelays();
  ui.steps(SETUP_STEPS, 2);
  ui.heading("Rogue Network", "Add ws:// or wss:// relay URLs, or press Enter to skip.");
  if (relays.length) {
    ui.hint(`Already configured (${relays.length}):`);
    ui.chips(relays);
    ui.write();
  }
  while (true) {
    const answer = await ui.text({ label: "Relay URL", placeholder: "(Enter to finish)", allowEmpty: true });
    if (!answer) break;
    try {
      relays = await nostr.addRelay(answer);
      ui.success(`Saved · ${relays.length} relay${relays.length === 1 ? "" : "s"} configured.`);
    } catch (error) {
      ui.fail(error instanceof Error ? error.message : String(error));
    }
  }
  if (relays.length) {
    ui.write();
    ui.chips(relays);
  } else {
    ui.hint("No relays configured. The agent can add them later with its Nostr tools.");
  }
  ui.write();
}

async function ensureModelProvider(options: CliOptions, firstRun: boolean): Promise<void> {
  const stateDirectory = options.stateDirectory ?? ".rogue";
  const config = new RogueConfigStore(stateDirectory);
  if ((await config.listProviders()).length) return;
  if (!stdin.isTTY) {
    throw new Error("No model provider is configured. Run Rogue in an interactive terminal to complete first-run setup, or run --auth first.");
  }
  if (firstRun) ui.steps(SETUP_STEPS, 1);
  await runProviderSetup({
    stateDirectory,
    provider: options.provider,
    model: options.model,
    offerFallbacks: true,
    onboarding: firstRun,
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.selfCheck) {
    const result = await verifyBundledProviderRuntime();
    console.log(`Bundle self-check passed · ${result.providers} providers · OAuth ${result.oauth} · Bedrock ${result.bedrock} · ${result.codingTools} coding tools`);
    return;
  }
  if (options.authenticate) {
    await runAuthentication(options.authProvider, options.stateDirectory, options.model);
    return;
  }
  if (options.apiKeyProvider) {
    await runApiKeySetup(options.apiKeyProvider, options.model, options.stateDirectory);
    return;
  }
  if (options.nostrRelays.length) {
    const nostr = new NostrService(options.stateDirectory ?? ".rogue");
    for (const relay of options.nostrRelays) await nostr.addRelay(relay);
  }

  await importInitialAuthentication(options.stateDirectory ?? ".rogue");
  const firstRun = await ensureActiveProfile(options);
  await ensureModelProvider(options, firstRun);
  if (firstRun) await configureInitialRelays(options);
  const transcriptEvents: unknown[] = [];
  const transcriptMessages: unknown[] = [];
  const { agent, store, profile, config, contextCompactor, provider, model, systemPrompt } = await createRogueAgent({
    ...options,
    onFailover(notice) {
      // A silent switch makes the next error look like it came from the
      // provider the operator selected, so announce every route change.
      transcriptEvents.push({ type: "model_failover", ...notice, timestamp: Date.now() });
      process.stderr.write(`\n  ${ui.style.warning("⚠")} ${notice.from} unavailable (${notice.reason}) — falling back to ${ui.style.bold(notice.to)}\n`);
    },
  });
  let wroteText = false;
  let responseText = "";
  let running = false;
  let liveMessage: unknown;
  agent.subscribe((event) => {
    transcriptEvents.push(event);
    if (event.type === "agent_start") running = true;
    if (event.type === "agent_end") running = false;
    if (event.type === "message_update") liveMessage = event.message;
    if (event.type === "message_end") {
      transcriptMessages.push(event.message);
      liveMessage = undefined;
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      stdout.write(event.assistantMessageEvent.delta);
      responseText += event.assistantMessageEvent.delta;
      wroteText = true;
    } else if (event.type === "tool_execution_start") {
      process.stderr.write(`\n  ${ui.style.info("↳")} ${ui.style.faint(event.toolName)}\n`);
    }
  });

  const introspection = await startIntrospectionServer({
    profile,
    host: options.inspectHost,
    getSnapshot: () => ({
      systemPrompt,
      messages: liveMessage ? [...transcriptMessages, liveMessage] : transcriptMessages,
      events: transcriptEvents,
      error: agent.state.errorMessage,
      running,
      route: `${provider}/${model}`,
      compactions: contextCompactor.records,
    }),
  });
  process.stderr.write(`  ${ui.style.info("◎")} ${ui.style.faint("Read-only transcript")} ${ui.style.underline(introspection.url)}\n`);

  const runPrompt = async (input: string): Promise<string> => {
    wroteText = false;
    responseText = "";
    await agent.prompt(input);
    if (wroteText) stdout.write("\n");
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
    return responseText.trim();
  };

  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    agent.abort();
  };
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    if (options.prompt) {
      await runPrompt(options.prompt);
      return;
    }

    const identity = `${profile.name} ${ui.style.faint(`· ${profile.country} · ${profile.personaLabel}`)}`;
    if (options.interactive) {
      ui.panel("Supervised session", [
        ["Agent", identity],
        ["Route", `${provider}${ui.style.faint("/")}${model}`],
        ["Commands", `${ui.style.bold(":reset")} clear conversation · ${ui.style.bold(":help")} · ${ui.style.bold(":quit")}`],
      ]);
      const readline = createInterface({ input: stdin, output: stdout });
      try {
        while (true) {
          const input = (await readline.question(`  ${ui.style.accent("❯")} `)).trim();
          if (!input) continue;
          if (input === ":quit" || input === ":q") break;
          if (input === ":help") {
            ui.hint("Enter a message, or use :reset to clear this conversation and :quit to exit.");
            continue;
          }
          if (input === ":reset") {
            agent.reset();
            ui.success("Conversation cleared. Durable memory remains.");
            continue;
          }
          stdout.write(`  ${ui.style.accent(profile.name)} ${ui.style.faint("›")} `);
          await runPrompt(input);
        }
      } finally {
        readline.close();
      }
      return;
    }

    const fallbackRoutes = options.allowFailover
      ? (await config.listProviders())
        .map((route) => `${route.provider}/${route.model}`)
        .filter((route) => route !== `${provider}/${model}`)
      : [];
    if (options.intervalSeconds !== undefined) await config.setWakeupIntervalSeconds(options.intervalSeconds);
    const wakeupIntervalSeconds = await config.getWakeupIntervalSeconds();
    ui.panel("Autonomous session", [
      ["Agent", identity],
      ["Route", `${provider}${ui.style.faint("/")}${model}`],
      ["Fallbacks", fallbackRoutes.length
        ? fallbackRoutes.join(ui.style.faint(" → "))
        : ui.style.faint(options.allowFailover ? "none configured" : "disabled (--no-failover)")],
      ["Cadence", `${wakeupIntervalSeconds}s between wakeups${options.maxCycles ? ` · max ${options.maxCycles} cycles` : ""}`],
    ]);

    const recordResult = async (result: AutonomousCycleResult): Promise<void> => {
      await store.recordAutonomyCycle({
        cycle: result.cycle,
        prompt: buildAutonomousCyclePrompt(result.cycle),
        ok: result.ok,
        output: result.output,
        error: result.error,
      });
      if (!result.ok) process.stderr.write(`  ${ui.style.danger("✖")} cycle ${result.cycle} failed: ${result.error}\n`);
    };

    const result = await runAutonomousLoop({
      intervalMs: wakeupIntervalSeconds * 1000,
      maxIntervalMs: MAX_WAKEUP_INTERVAL_SECONDS * 1000,
      getIntervalMs: async () => (await config.getWakeupIntervalSeconds()) * 1000,
      maxCycles: options.maxCycles,
      signal: controller.signal,
      onCycleStart(cycle) {
        process.stderr.write(`\n  ${ui.style.accent("◆")} ${ui.style.faint(`autonomous cycle ${cycle}`)}\n`);
      },
      onCycleResult: recordResult,
      async runCycle(prompt, cycle) {
        return runPrompt(prompt);
      },
    });
    ui.write();
    ui.info(`Autonomy stopped · ${ui.style.success(`${result.completed} completed`)} · ${result.failed ? ui.style.danger(`${result.failed} failed`) : ui.style.faint("0 failed")}`);
    if (result.attempted > 0 && result.completed === 0 && !result.aborted) process.exitCode = 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    await introspection.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ui.CancelledError) {
    // A deliberate escape during setup is not a failure worth a stack-style report.
    process.stderr.write(`\n  ${ui.style.warning("!")} ${message}\n`);
    process.exitCode = 130;
    return;
  }
  process.stderr.write(`\n  ${ui.style.danger("✖")} Rogue could not start: ${message}\n`);
  process.exitCode = 1;
});
