import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const PREFIX = "enc:v1";
const LEGACY_PREFIX = "v1";

export class PiiCipher {
  private readonly key: Buffer;
  private readonly legacyKey: Buffer;
  private readonly indexKey: Buffer;

  constructor(secret: string) {
    if (!secret) throw new Error("PII_ENCRYPTION_KEY não configurada");
    this.key = createHash("sha256").update(`bioecos:pii:v2:${secret}`).digest();
    this.legacyKey = createHash("sha256").update(secret).digest();
    this.indexKey = createHash("sha256").update(`bioecos:pii-index:v1:${secret}`).digest();
  }

  encrypt(value: string): string {
    if (value.startsWith(`${PREFIX}:`)) return value;
    const plaintext = value.startsWith(`${LEGACY_PREFIX}:`) ? this.decryptLegacy(value) : value;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${PREFIX}:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
  }

  decrypt(value: string): string {
    if (value.startsWith(`${LEGACY_PREFIX}:`)) return this.decryptLegacy(value);
    if (!value.startsWith(`${PREFIX}:`)) return value;
    return this.decryptWithKey(value, this.key, 2);
  }

  encryptNullable(value: string | null | undefined): string | null {
    return value == null ? null : this.encrypt(value);
  }

  decryptNullable(value: string | null | undefined): string | null {
    return value == null ? null : this.decrypt(value);
  }

  phoneHash(phone: string): string {
    return createHmac("sha256", this.indexKey).update(normalizePhone(phone)).digest("hex");
  }

  isEncrypted(value: unknown): value is string {
    return typeof value === "string" && value.startsWith(`${PREFIX}:`);
  }

  private decryptLegacy(value: string): string {
    return this.decryptWithKey(value, this.legacyKey, 1);
  }

  private decryptWithKey(value: string, key: Buffer, prefixParts: number): string {
    const parts = value.split(":");
    const iv = Buffer.from(parts[prefixParts] ?? "", "base64");
    const tag = Buffer.from(parts[prefixParts + 1] ?? "", "base64");
    const encrypted = Buffer.from(parts[prefixParts + 2] ?? "", "base64");
    if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) throw new Error("Dado pessoal cifrado está corrompido");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}
