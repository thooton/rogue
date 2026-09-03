import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type CredentialFile = Record<string, Credential>;

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** A private, atomic, file-backed implementation of Pi's CredentialStore. */
export class FileCredentialStore implements CredentialStore {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.path = path.resolve(filePath);
  }

  private async load(): Promise<CredentialFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Credential file must contain a JSON object.");
      }
      return parsed as CredentialFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async save(credentials: CredentialFile): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async serialized<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const value = (await this.load())[providerId];
    return value ? copy(value) : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(await this.load()).flatMap(([providerId, credential]) =>
      credential?.type === "api_key" || credential?.type === "oauth"
        ? [{ providerId, type: credential.type }]
        : [],
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.serialized(async () => {
      const credentials = await this.load();
      const current = credentials[providerId];
      const next = await fn(current ? copy(current) : undefined);
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        credentials[providerId] = copy(next);
        await this.save(credentials);
        return copy(next);
      }
      return current ? copy(current) : undefined;
    }, options?.signal);
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.serialized(async () => {
      const credentials = await this.load();
      if (providerId in credentials) {
        delete credentials[providerId];
        await this.save(credentials);
      }
    }, options?.signal);
  }
}
