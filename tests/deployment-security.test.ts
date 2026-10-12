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

  it("inclui o portal e seus metadados sociais na imagem de produção", async () => {
    const dockerignore = await readFile(".dockerignore", "utf8");
    const dockerfile = await readFile("Dockerfile", "utf8");
    expect(dockerignore.split(/\r?\n/)).not.toContain("docs");
    expect(dockerfile).toContain("COPY docs ./docs");
    expect(dockerfile).toContain("COPY --from=build --chown=node:node /app/docs ./docs");
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

  it("expande a base por migração aditiva e impede o seed de desativar conteúdos do portal", async () => {
    const migration = await readFile("src/db/migrations/008_managed_knowledge.sql", "utf8");
    const seed = await readFile("src/db/seed.ts", "utf8");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS managed_knowledge_entries");
    expect(migration).toContain("document_id uuid NOT NULL UNIQUE REFERENCES knowledge_documents");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS knowledge_media");
    expect(migration).not.toMatch(/\b(DROP|TRUNCATE)\b/i);
    expect(seed).toContain("source LIKE 'config/knowledge/%'");
    expect(seed).not.toMatch(/UPDATE knowledge_documents SET active = false WHERE project_id = \$1`/);
  });
});
