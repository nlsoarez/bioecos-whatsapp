import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Env } from "../config/env.js";

interface SessionPayload {
  exp: number;
  sub: string;
  nonce: string;
}

const failedLogins = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function authenticateCredentials(env: Env, username: string, password: string, clientId: string): boolean {
  const now = Date.now();
  const attempts = failedLogins.get(clientId);
  if (attempts && attempts.resetAt > now && attempts.count >= MAX_ATTEMPTS) return false;
  if (attempts && attempts.resetAt <= now) failedLogins.delete(clientId);

  const valid = secureEqual(username, env.DASHBOARD_USERNAME) && secureEqual(password, env.DASHBOARD_PASSWORD);
  if (valid) {
    failedLogins.delete(clientId);
    return true;
  }
  const current = failedLogins.get(clientId);
  failedLogins.set(clientId, {
    count: (current?.count ?? 0) + 1,
    resetAt: current?.resetAt && current.resetAt > now ? current.resetAt : now + LOGIN_WINDOW_MS,
  });
  return false;
}

export function createSessionToken(env: Env, username: string, now = Date.now()): string {
  const payload: SessionPayload = {
    exp: now + env.DASHBOARD_SESSION_TTL_MINUTES * 60_000,
    sub: username,
    nonce: randomBytes(12).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, env.DASHBOARD_SESSION_SECRET)}`;
}

export function requireDashboardSession(request: FastifyRequest, env: Env, now = Date.now()): SessionPayload {
  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !secureEqual(signature, sign(encoded, env.DASHBOARD_SESSION_SECRET))) {
    throw unauthorized();
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (payload.exp <= now || payload.sub !== env.DASHBOARD_USERNAME) throw unauthorized();
    return payload;
  } catch {
    throw unauthorized();
  }
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function unauthorized(): Error & { statusCode: number } {
  const error = new Error("Sessão inválida ou expirada") as Error & { statusCode: number };
  error.statusCode = 401;
  return error;
}
