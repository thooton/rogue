import { appendFile, mkdir, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContextCompactionState } from "./context-compaction.js";
import { redactedJson } from "./redaction.js";

const TRANSCRIPT_FILE = "session-transcript.jsonl";
const STATE_FILE = "session-state.json";
const AUTONOMOUS_WAKEUP = /^Autonomous wakeup #(\d+), please continue$/;

export const INTERRUPTED_TOOL_RESULT =
  "Interrupted: the Rogue process stopped before this tool call finished. Its effect on the host is unknown; verify before assuming it did or did not happen.";

interface PersistedSessionState {
  /** Number of the most recent autonomous cycle that was started. */
  cycle: number;
  compaction?: ContextCompactionState;
  updatedAt: string;
}

export interface RestoredSession {
  messages: AgentMessage[];
  cycle: number;
  compaction?: ContextCompactionState;
  /** Tool calls that were still running when the previous process died. */
  interruptedToolCalls: number;
  /** True when the transcript ends mid-turn and must be continued, not re-prompted. */
  resumable: boolean;
  /** Cycle number encoded by the unanswered wakeup that owns the current turn. */
  activeCycle?: number;
}

function isToolCallBlock(block: unknown): block is { type: "toolCall"; id: string; name: string } {
  return typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall";
}

function messageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function autonomousCycle(message: AgentMessage): number | undefined {
  const match = AUTONOMOUS_WAKEUP.exec(messageText(message));
  if (!match) return undefined;
  const cycle = Number(match[1]);
  return Number.isSafeInteger(cycle) && cycle > 0 ? cycle : undefined;
}

/**
 * True for messages that belong to the conversation itself.
 *
 * A failed or aborted turn is a runtime marker the agent synthesizes locally,
 * not something the Rogue said. Keeping it out of durable state is what lets an
 * interrupted turn be continued after a restart instead of replaced by an empty
 * assistant reply that no provider would accept back.
 */
export function isDurableMessage(message: AgentMessage): boolean {
  const candidate = message as { role?: string; stopReason?: string };
  if (candidate.role !== "assistant") return true;
  return candidate.stopReason !== "error" && candidate.stopReason !== "aborted";
}

/**
 * Tool results are appended only once a tool finishes, so a process killed
 * mid-batch leaves assistant tool calls that no provider will accept. Close
 * them with honest error results instead of dropping the assistant message,
 * which would erase what the Rogue was doing.
 */
export function repairInterruptedToolCalls(messages: AgentMessage[]): ToolResultMessage[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if ((message as { role?: string }).role === "toolResult") answered.add((message as ToolResultMessage).toolCallId);
  }
  const repairs: ToolResultMessage[] = [];
  for (const message of messages) {
    if ((message as { role?: string }).role !== "assistant") continue;
    for (const block of (message as { content?: unknown[] }).content ?? []) {
      if (!isToolCallBlock(block) || answered.has(block.id)) continue;
      answered.add(block.id);
      repairs.push({
        role: "toolResult",
        toolCallId: block.id,
        toolName: block.name,
        content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }
  return repairs;
}

/**
 * Durable conversation state for one installation.
 *
 * The transcript is an append-only log so that persisting a message costs one
 * small write no matter how long the Rogue has been alive; the sidecar state
 * file carries only the little that cannot be derived from it. Together they
 * let a killed process come back with the same conversation.
 */
export class SessionStore {
  readonly directory: string;
  readonly transcriptPath: string;
  readonly statePath: string;
  private queue: Promise<void> = Promise.resolve();
  private state: PersistedSessionState = { cycle: 0, updatedAt: new Date(0).toISOString() };
  private readonly onError: (error: unknown) => void;

  constructor(stateDirectory: string, options: { onError?: (error: unknown) => void } = {}) {
    this.directory = path.resolve(stateDirectory);
    this.transcriptPath = path.join(this.directory, TRANSCRIPT_FILE);
    this.statePath = path.join(this.directory, STATE_FILE);
    this.onError = options.onError ?? (() => {});
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  /** Read the persisted conversation, repairing anything a kill left half-written. */
  async load(): Promise<RestoredSession> {
    const messages = await this.readTranscript();
    const state = await this.readState();
    // The transcript is authoritative. If a process died after appending a
    // wakeup but before updating the sidecar, recover its number from the log.
    const transcriptCycle = messages.reduce((latest, message) => autonomousCycle(message) ?? latest, 0);
    state.cycle = Math.max(state.cycle, transcriptCycle);
    this.state = state;
    const repairs = repairInterruptedToolCalls(messages);
    if (repairs.length) {
      messages.push(...repairs);
      await this.appendMessages(repairs);
    }
    const last = messages.at(-1) as { role?: string } | undefined;
    const resumable = last !== undefined && last.role !== "assistant";
    let activeCycle: number | undefined;
    if (resumable) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]!.role !== "user") continue;
        activeCycle = autonomousCycle(messages[index]!);
        break;
      }
    }
    return {
      messages,
      cycle: state.cycle,
      compaction: state.compaction,
      interruptedToolCalls: repairs.length,
      // A transcript ending in a user or tool-result message is an unanswered
      // turn: the previous process died before the model replied to it.
      resumable,
      activeCycle,
    };
  }

  private async readTranscript(): Promise<AgentMessage[]> {
    let raw: string;
    try {
      raw = await readFile(this.transcriptPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const terminated = raw.endsWith("\n");
    const lines = raw.split("\n");
    if (terminated) lines.pop();
    const messages: AgentMessage[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line) continue;
      try {
        messages.push(JSON.parse(line) as AgentMessage);
      } catch (error) {
        if (terminated || index !== lines.length - 1) {
          throw new Error(`Corrupt durable transcript at line ${index + 1}`, { cause: error });
        }
        // A process kill may cut off the one write at the tail. Remove only
        // that incomplete fragment so the next append begins on a clean line.
        const completePrefix = raw.lastIndexOf("\n") + 1;
        await truncate(this.transcriptPath, Buffer.byteLength(raw.slice(0, completePrefix)));
        return messages;
      }
    }
    // A complete JSON write can still be killed just before its final newline.
    // Finish the delimiter now so a later append remains a separate record.
    if (!terminated && raw.length > 0) await appendFile(this.transcriptPath, "\n", { mode: 0o600 });
    return messages;
  }

  private async readState(): Promise<PersistedSessionState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<PersistedSessionState>;
      return {
        cycle: Number.isSafeInteger(parsed.cycle) && parsed.cycle! > 0 ? parsed.cycle! : 0,
        compaction: parsed.compaction,
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cycle: 0, updatedAt: new Date(0).toISOString() };
      throw error;
    }
  }

  async appendMessages(messages: AgentMessage[]): Promise<void> {
    if (!messages.length) return;
    const lines = messages.map((message) => `${redactedJson(message)}\n`).join("");
    await this.serialized(async () => {
      await this.ensureDirectory();
      await appendFile(this.transcriptPath, lines, { mode: 0o600 });
    });
  }

  /** Persist a message without letting a storage failure abort the agent's run. */
  async recordMessage(message: AgentMessage): Promise<void> {
    try {
      await this.appendMessages([message]);
      const cycle = autonomousCycle(message);
      if (cycle !== undefined) await this.saveCycle(cycle);
    } catch (error) {
      this.onError(error);
    }
  }

  async saveCycle(cycle: number): Promise<void> {
    await this.writeState({ ...this.state, cycle });
  }

  async saveCompaction(compaction: ContextCompactionState): Promise<void> {
    await this.writeState({ ...this.state, compaction });
  }

  private async writeState(next: PersistedSessionState): Promise<void> {
    this.state = { ...next, updatedAt: new Date().toISOString() };
    const value = this.state;
    try {
      await this.serialized(async () => {
        await this.ensureDirectory();
        const temporary = `${this.statePath}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, `${redactedJson(value, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.statePath);
      });
    } catch (error) {
      this.onError(error);
    }
  }

  /** Forget the conversation. Durable memory, initiatives, and identity remain. */
  async clear(): Promise<void> {
    await this.serialized(async () => {
      await rm(this.transcriptPath, { force: true });
      await rm(this.statePath, { force: true });
    });
    this.state = { cycle: 0, updatedAt: new Date().toISOString() };
  }

  /** Wait until every queued transcript and sidecar write has reached disk. */
  async flush(): Promise<void> {
    await this.queue.catch(() => {});
  }
}
