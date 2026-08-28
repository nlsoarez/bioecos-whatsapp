import { describe, expect, it } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { PiiCipher } from "../src/security/pii-cipher.js";

describe("criptografia de dados pessoais", () => {
  it("cifra de forma não determinística e recupera o valor", () => {
    const cipher = new PiiCipher("segredo-de-teste-com-mais-de-32-caracteres");
    const first = cipher.encrypt("Nelson");
    const second = cipher.encrypt("Nelson");
    expect(first).not.toBe(second);
    expect(first).not.toContain("Nelson");
    expect(cipher.decrypt(first)).toBe("Nelson");
    expect(cipher.decrypt(second)).toBe("Nelson");
  });

  it("gera índice estável de telefone sem expor o número", () => {
    const cipher = new PiiCipher("segredo-de-teste-com-mais-de-32-caracteres");
    expect(cipher.phoneHash("+55 (21) 99999-0000")).toBe(cipher.phoneHash("5521999990000"));
    expect(cipher.phoneHash("5521999990000")).not.toContain("99999");
  });

  it("migra o formato legado de CPF", () => {
    const secret = "segredo-de-teste-com-mais-de-32-caracteres";
    const key = createHash("sha256").update(secret).digest();
    const iv = randomBytes(12);
    const legacy = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([legacy.update("12345678900", "utf8"), legacy.final()]);
    const value = `v1:${iv.toString("base64")}:${legacy.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
    const cipher = new PiiCipher(secret);
    const migrated = cipher.encrypt(value);
    expect(migrated.startsWith("enc:v1:")).toBe(true);
    expect(cipher.decrypt(migrated)).toBe("12345678900");
  });
});
