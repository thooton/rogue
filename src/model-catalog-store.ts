import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
} from "@earendil-works/pi-ai";

type CatalogFile = Record<string, ModelsStoreEntry>;

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Private, atomic persistence for provider-owned dynamic model catalogs. */
export class FileModelsStore implements ModelsStore {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.path = path.resolve(filePath);
  }

  private async load(): Promise<CatalogFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Model catalog file must contain a JSON object.");
      }
      return parsed as CatalogFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async save(catalogs: CatalogFile): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(catalogs, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async serialized<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
    options?.signal?.throwIfAborted();
    const entry = (await this.load())[providerId];
    return entry ? copy(entry) : undefined;
  }

  write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
    return this.serialized(async () => {
      const catalogs = await this.load();
      catalogs[providerId] = copy(entry);
      await this.save(catalogs);
    }, options?.signal);
  }

  delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    return this.serialized(async () => {
      const catalogs = await this.load();
      if (providerId in catalogs) {
        delete catalogs[providerId];
        await this.save(catalogs);
      }
    }, options?.signal);
  }
}
