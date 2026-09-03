import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProviderRoute {
  provider: string;
  model: string;
  priority: number;
  enabled: boolean;
}

export interface FailoverRecord {
  from: string;
  to: string;
  reason: string;
  createdAt: string;
}

interface RogueConfig {
  providers: ProviderRoute[];
  failovers: FailoverRecord[];
}

const EMPTY_CONFIG: RogueConfig = { providers: [], failovers: [] };

export class RogueConfigStore {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(stateDirectory: string) {
    this.path = path.resolve(stateDirectory, "config.json");
  }

  private async load(): Promise<RogueConfig> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<RogueConfig>;
      return {
        providers: parsed.providers ?? [],
        failovers: parsed.failovers ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_CONFIG);
      throw error;
    }
  }

  private async save(config: RogueConfig): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async mutate(operation: (config: RogueConfig) => void): Promise<void> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      const config = await this.load();
      operation(config);
      await this.save(config);
    } finally {
      release();
    }
  }

  async listProviders(): Promise<ProviderRoute[]> {
    return (await this.load()).providers.filter((route) => route.enabled).sort((a, b) => a.priority - b.priority);
  }

  async configureProvider(route: Omit<ProviderRoute, "enabled"> & { enabled?: boolean }): Promise<void> {
    await this.mutate((config) => {
      const existing = config.providers.find((candidate) => candidate.provider === route.provider && candidate.model === route.model);
      if (existing) Object.assign(existing, route, { enabled: route.enabled ?? true });
      else config.providers.push({ ...route, enabled: route.enabled ?? true });
    });
  }

  async disableProvider(provider: string, model: string): Promise<void> {
    await this.mutate((config) => {
      const route = config.providers.find((candidate) => candidate.provider === provider && candidate.model === model);
      if (route) route.enabled = false;
    });
  }

  async recordFailover(record: Omit<FailoverRecord, "createdAt">): Promise<void> {
    await this.mutate((config) => {
      config.failovers.push({ ...record, createdAt: new Date().toISOString() });
      config.failovers = config.failovers.slice(-100);
    });
  }

  async recentFailovers(): Promise<FailoverRecord[]> {
    return (await this.load()).failovers.slice(-20).reverse();
  }
}
