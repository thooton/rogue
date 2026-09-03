import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertNetworkDraftContent } from "./network-policy.js";

export type MemoryCategory = "identity" | "preference" | "decision" | "lesson" | "contact";

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  content: string;
  createdAt: string;
}

export type InitiativeStatus = "idea" | "active" | "blocked" | "complete" | "abandoned";

export interface Initiative {
  id: string;
  title: string;
  summary: string;
  expectedBenefit: string;
  risks: string;
  nextStep: string;
  status: InitiativeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkDraft {
  id: string;
  audience: "public" | "direct";
  recipient?: string;
  content: string;
  createdAt: string;
  published: false;
}

export interface AutonomyCycle {
  id: string;
  cycle: number;
  prompt: string;
  ok: boolean;
  output?: string;
  error?: string;
  createdAt: string;
}

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

export class RogueStore {
  readonly directory: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  private file(name: string): string {
    return path.join(this.directory, name);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readJsonLines<T>(name: string): Promise<T[]> {
    try {
      const raw = await readFile(this.file(name), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as T];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async readJson<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(this.file(name), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }

  private async writeJsonAtomic(name: string, value: unknown): Promise<void> {
    await this.ensureDirectory();
    const destination = this.file(name);
    const temporary = this.file(`.${name}.${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  async remember(category: MemoryCategory, content: string): Promise<MemoryEntry> {
    return this.serialized(async () => {
      await this.ensureDirectory();
      const entry: MemoryEntry = {
        id: id("mem"),
        category,
        content: content.trim(),
        createdAt: new Date().toISOString(),
      };
      await appendFile(this.file("memory.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      return entry;
    });
  }

  async recall(query = "", limit = 10): Promise<MemoryEntry[]> {
    const entries = await this.readJsonLines<MemoryEntry>("memory.jsonl");
    return entries
      .filter((entry) => !query || contains(`${entry.category} ${entry.content}`, query))
      .slice(-limit)
      .reverse();
  }

  async memorySummary(limit = 20): Promise<string> {
    const memories = await this.recall("", limit);
    if (memories.length === 0) return "No durable memories recorded yet.";
    return memories.map((memory) => `- [${memory.category}] ${memory.content}`).join("\n");
  }

  async createInitiative(
    input: Omit<Initiative, "id" | "status" | "createdAt" | "updatedAt">,
  ): Promise<Initiative> {
    return this.serialized(async () => {
      const initiatives = await this.readJson<Initiative[]>("initiatives.json", []);
      const now = new Date().toISOString();
      const initiative: Initiative = { ...input, id: id("init"), status: "idea", createdAt: now, updatedAt: now };
      initiatives.push(initiative);
      await this.writeJsonAtomic("initiatives.json", initiatives);
      return initiative;
    });
  }

  async listInitiatives(status?: InitiativeStatus): Promise<Initiative[]> {
    const initiatives = await this.readJson<Initiative[]>("initiatives.json", []);
    return initiatives.filter((initiative) => !status || initiative.status === status);
  }

  async updateInitiative(idValue: string, status: InitiativeStatus, nextStep?: string): Promise<Initiative> {
    return this.serialized(async () => {
      const initiatives = await this.readJson<Initiative[]>("initiatives.json", []);
      const initiative = initiatives.find((candidate) => candidate.id === idValue);
      if (!initiative) throw new Error(`Unknown initiative: ${idValue}`);
      initiative.status = status;
      if (nextStep !== undefined) initiative.nextStep = nextStep.trim();
      initiative.updatedAt = new Date().toISOString();
      await this.writeJsonAtomic("initiatives.json", initiatives);
      return initiative;
    });
  }

  async draftNetworkMessage(input: Omit<NetworkDraft, "id" | "createdAt" | "published">): Promise<NetworkDraft> {
    assertNetworkDraftContent(input.content, input.audience);
    return this.serialized(async () => {
      await this.ensureDirectory();
      const draft: NetworkDraft = {
        ...input,
        id: id("draft"),
        createdAt: new Date().toISOString(),
        published: false,
      };
      await appendFile(this.file("network-outbox.jsonl"), `${JSON.stringify(draft)}\n`, { mode: 0o600 });
      return draft;
    });
  }

  async listNetworkDrafts(limit = 10): Promise<NetworkDraft[]> {
    return (await this.readJsonLines<NetworkDraft>("network-outbox.jsonl")).slice(-limit).reverse();
  }

  async recordAutonomyCycle(
    input: Omit<AutonomyCycle, "id" | "createdAt">,
  ): Promise<AutonomyCycle> {
    return this.serialized(async () => {
      await this.ensureDirectory();
      const entry: AutonomyCycle = {
        ...input,
        id: id("cycle"),
        createdAt: new Date().toISOString(),
      };
      await appendFile(this.file("autonomy-log.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      return entry;
    });
  }

  async listAutonomyCycles(limit = 20): Promise<AutonomyCycle[]> {
    return (await this.readJsonLines<AutonomyCycle>("autonomy-log.jsonl")).slice(-limit).reverse();
  }
}
