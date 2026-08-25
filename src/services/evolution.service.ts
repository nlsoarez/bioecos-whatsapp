import type { Env } from "../config/env.js";
import type { InboundMessage } from "../domain/types.js";

export interface SendResult {
  externalMessageId: string;
  raw: unknown;
}

export interface MessageSender {
  sendText(phone: string, text: string): Promise<SendResult>;
}

export interface EvolutionConnectionState {
  configured: boolean;
  reachable: boolean;
  state: string;
}

export interface EvolutionQrCode {
  base64: string;
  pairingCode: string | null;
  count: number;
}

export class EvolutionService implements MessageSender {
  constructor(private readonly env: Env, private readonly request: typeof fetch = fetch) {}

  async sendText(phone: string, text: string): Promise<SendResult> {
    if (!this.env.EVOLUTION_API_KEY) throw new Error("EVOLUTION_API_KEY não configurada");
    const url = `${this.env.EVOLUTION_API_URL.replace(/\/$/, "")}/message/sendText/${encodeURIComponent(this.env.EVOLUTION_INSTANCE_NAME)}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.env.EVOLUTION_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.env.EVOLUTION_REQUEST_TIMEOUT_MS);
      try {
        const response = await this.request(url, {
          method: "POST",
          headers: { "content-type": "application/json", apikey: this.env.EVOLUTION_API_KEY },
          body: JSON.stringify({ number: normalizePhone(phone), textMessage: { text } }),
          signal: controller.signal,
        });
        const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (response.ok) {
          const key = raw.key as Record<string, unknown> | undefined;
          return { externalMessageId: String(key?.id ?? `evolution:${Date.now()}`), raw };
        }
        if (response.status < 500 || attempt === this.env.EVOLUTION_MAX_RETRIES) {
          throw new Error(`Evolution API respondeu ${response.status}: ${JSON.stringify(raw)}`);
        }
        lastError = new Error(`Evolution API respondeu ${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt === this.env.EVOLUTION_MAX_RETRIES) throw error;
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
    throw lastError;
  }

  async connectionState(): Promise<EvolutionConnectionState> {
    if (!this.env.EVOLUTION_API_KEY) return { configured: false, reachable: false, state: "unconfigured" };
    const url = `${this.env.EVOLUTION_API_URL.replace(/\/$/, "")}/instance/connectionState/${encodeURIComponent(this.env.EVOLUTION_INSTANCE_NAME)}`;
    try {
      const response = await this.request(url, { headers: { apikey: this.env.EVOLUTION_API_KEY } });
      const result = await response.json().catch(() => ({})) as { instance?: { state?: unknown }; state?: unknown };
      return {
        configured: true,
        reachable: response.ok,
        state: String(result.instance?.state ?? result.state ?? (response.ok ? "unknown" : "unreachable")),
      };
    } catch {
      return { configured: true, reachable: false, state: "unreachable" };
    }
  }

  async health(): Promise<EvolutionConnectionState> {
    return this.connectionState();
  }

  async connect(): Promise<EvolutionQrCode> {
    if (!this.env.EVOLUTION_API_KEY) throw new Error("EVOLUTION_API_KEY não configurada");
    const url = `${this.env.EVOLUTION_API_URL.replace(/\/$/, "")}/instance/connect/${encodeURIComponent(this.env.EVOLUTION_INSTANCE_NAME)}`;
    const response = await this.request(url, { headers: { apikey: this.env.EVOLUTION_API_KEY } });
    const result = await response.json().catch(() => ({})) as { base64?: unknown; pairingCode?: unknown; count?: unknown };
    if (!response.ok) throw new Error(`Evolution API respondeu ${response.status}`);
    const base64 = typeof result.base64 === "string" ? result.base64 : "";
    if (!base64.startsWith("data:image/png;base64,") || base64.length > 2_000_000) {
      throw new Error("A Evolution não retornou um QR Code válido");
    }
    return {
      base64,
      pairingCode: typeof result.pairingCode === "string" ? result.pairingCode : null,
      count: typeof result.count === "number" ? result.count : 0,
    };
  }
}

export function normalizePhone(input: string): string {
  const jid = input.split("@")[0] ?? input;
  const digits = jid.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) throw new Error("Número de telefone inválido");
  return digits;
}

function messageText(message: Record<string, unknown>): string | null {
  if (typeof message.conversation === "string") return message.conversation;
  const extended = message.extendedTextMessage as Record<string, unknown> | undefined;
  if (typeof extended?.text === "string") return extended.text;
  const image = message.imageMessage as Record<string, unknown> | undefined;
  if (typeof image?.caption === "string") return image.caption;
  const video = message.videoMessage as Record<string, unknown> | undefined;
  if (typeof video?.caption === "string") return video.caption;
  return null;
}

export function parseEvolutionWebhook(payload: unknown): InboundMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const event = String(root.event ?? root.type ?? "").toUpperCase().replace(/[.-]/g, "_");
  if (event && event !== "MESSAGES_UPSERT" && event !== "MESSAGE") return null;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  const key = data.key as Record<string, unknown> | undefined;
  if (!key || key.fromMe === true) return null;
  const remoteJid = String(key.remoteJid ?? "");
  if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return null;
  const message = data.message as Record<string, unknown> | undefined;
  const content = message ? messageText(message) : null;
  if (!content?.trim()) return null;
  const externalMessageId = String(key.id ?? data.id ?? "");
  if (!externalMessageId) return null;
  const rawTimestamp = data.messageTimestamp ?? root.date_time;
  const numericTimestamp = Number(rawTimestamp);
  const timestamp = Number.isFinite(numericTimestamp)
    ? new Date(numericTimestamp > 10_000_000_000 ? numericTimestamp : numericTimestamp * 1000)
    : new Date();
  return {
    externalMessageId,
    phone: normalizePhone(remoteJid),
    pushName: typeof data.pushName === "string" ? data.pushName : null,
    content: content.trim(),
    timestamp,
    raw: payload,
  };
}
