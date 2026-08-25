import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { loadEnv } from "../src/config/env.js";
import { authenticateCredentials, createSessionToken, requireDashboardSession } from "../src/security/dashboard-auth.js";

const env = loadEnv({
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  EVOLUTION_API_URL: "http://localhost:8080",
  EVOLUTION_INSTANCE_NAME: "bioecos",
  ADMIN_API_KEY: "admin-secret-key",
  DASHBOARD_USERNAME: "operador",
  DASHBOARD_PASSWORD: "dashboard-password-secret",
  DASHBOARD_SESSION_SECRET: "dashboard-session-secret-at-least-32-chars",
});

describe("autenticação do dashboard", () => {
  it("valida credenciais sem comparação textual insegura", () => {
    expect(authenticateCredentials(env, "operador", "dashboard-password-secret", "valid-client")).toBe(true);
    expect(authenticateCredentials(env, "operador", "senha-errada", "invalid-client")).toBe(false);
  });

  it("emite e valida uma sessão com expiração", () => {
    const now = Date.now();
    const token = createSessionToken(env, "operador", now);
    const request = { headers: { authorization: `Bearer ${token}` } } as FastifyRequest;
    expect(requireDashboardSession(request, env, now + 1_000).sub).toBe("operador");
    expect(() => requireDashboardSession(request, env, now + env.DASHBOARD_SESSION_TTL_MINUTES * 60_000 + 1)).toThrow(/expirada/);
  });
});
