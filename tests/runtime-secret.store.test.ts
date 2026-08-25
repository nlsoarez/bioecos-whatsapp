import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeSecretStore } from "../src/security/runtime-secret.store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RuntimeSecretStore", () => {
  it("persiste a chave cifrada e nunca grava o valor em texto puro", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bioecos-secrets-"));
    directories.push(directory);
    const file = join(directory, "runtime-secrets.json");
    const store = new RuntimeSecretStore(file, "encryption-secret");
    const apiKey = "sk-proj-example-that-must-not-be-plain-text";

    await store.set("OPENAI_API_KEY", apiKey);

    expect(await store.get("OPENAI_API_KEY")).toBe(apiKey);
    expect(await store.status("OPENAI_API_KEY")).toMatchObject({ configured: true });
    expect(await readFile(file, "utf8")).not.toContain(apiKey);
  });

  it("remove o segredo sem deixar o status configurado", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bioecos-secrets-"));
    directories.push(directory);
    const store = new RuntimeSecretStore(join(directory, "runtime-secrets.json"), "encryption-secret");
    await store.set("OPENAI_API_KEY", "temporary-secret");
    await store.delete("OPENAI_API_KEY");
    expect(await store.get("OPENAI_API_KEY")).toBeNull();
    expect(await store.status("OPENAI_API_KEY")).toEqual({ configured: false, updatedAt: null });
  });
});
