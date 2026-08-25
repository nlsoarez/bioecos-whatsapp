import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface SecretEnvelope {
  ciphertext: string;
  iv: string;
  tag: string;
  updatedAt: string;
}

type SecretFile = Record<string, SecretEnvelope>;

export interface SecretStatus {
  configured: boolean;
  updatedAt: string | null;
}

export class RuntimeSecretStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly encryptionSecret: string,
  ) {}

  async get(name: string): Promise<string | null> {
    const envelope = (await this.readAll())[name];
    if (!envelope) return null;
    const key = this.encryptionKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  async status(name: string): Promise<SecretStatus> {
    const envelope = (await this.readAll())[name];
    return { configured: Boolean(envelope), updatedAt: envelope?.updatedAt ?? null };
  }

  async set(name: string, value: string): Promise<void> {
    if (!value) throw new Error("O segredo não pode ser vazio");
    await this.enqueue(async () => {
      const secrets = await this.readAll();
      const key = this.encryptionKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      secrets[name] = {
        ciphertext: ciphertext.toString("base64url"),
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        updatedAt: new Date().toISOString(),
      };
      await this.writeAll(secrets);
    });
  }

  async delete(name: string): Promise<void> {
    await this.enqueue(async () => {
      const secrets = await this.readAll();
      delete secrets[name];
      await this.writeAll(secrets);
    });
  }

  private encryptionKey(): Buffer {
    if (!this.encryptionSecret) throw new Error("PII_ENCRYPTION_KEY não configurada");
    return createHash("sha256").update(this.encryptionSecret).digest();
  }

  private async readAll(): Promise<SecretFile> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      return parsed && typeof parsed === "object" ? parsed as SecretFile : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeAll(secrets: SecretFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(secrets), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}
