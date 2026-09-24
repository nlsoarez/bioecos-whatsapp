import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("configuração segura de desenvolvimento", () => {
  it("não publica PostgreSQL na rede com senha fixa", async () => {
    const compose = await readFile("docker-compose.yml", "utf8");
    expect(compose).toContain("POSTGRES_PASSWORD: ${BIOECOS_DB_PASSWORD:?");
    expect(compose).toContain('"127.0.0.1:5432:5432"');
    expect(compose).toContain('"127.0.0.1:3000:3000"');
    expect(compose).not.toMatch(/POSTGRES_PASSWORD:\s*bioecos(?:\s|$)/);
    expect(compose).not.toContain('"5432:5432"');
    expect(compose).not.toContain('"3000:3000"');
  });

  it("persiste números ignorados com isolamento por projeto e índice de consulta ativo", async () => {
    const migration = await readFile("src/db/migrations/007_ignored_phone_numbers.sql", "utf8");
    const repository = await readFile("src/repositories/postgres.repository.ts", "utf8");
    expect(migration).toContain("project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE");
    expect(migration).toContain("UNIQUE(project_id, phone_hash)");
    expect(migration).toContain("WHERE active = true");
    expect(repository).toContain("p.id = i.project_id");
    expect(repository).toContain("p.slug = 'bioecos'");
  });
});
