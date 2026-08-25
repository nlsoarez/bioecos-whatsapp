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

export interface EvolutionWebhookState {
  configured: boolean;
  reachable: boolean;
  healthy: boolean;
  enabled: boolean;
  message: string;
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
          body: JSON.stringify({ number: normalizePhone(phone), text }),
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
    await this.configureWebhook();
    return {
      base64,
      pairingCode: typeof result.pairingCode === "string" ? result.pairingCode : null,
      count: typeof result.count === "number" ? result.count : 0,
    };
  }

  async webhookStatus(): Promise<EvolutionWebhookState> {
    const expectedUrl = this.webhookUrl();
    if (!this.env.EVOLUTION_API_KEY || !expectedUrl) {
      return { configured: false, reachable: false, healthy: false, enabled: false, message: "Webhook não configurado" };
    }
    const url = `${this.env.EVOLUTION_API_URL.replace(/\/$/, "")}/webhook/find/${encodeURIComponent(this.env.EVOLUTION_INSTANCE_NAME)}`;
    try {
      const response = await this.request(url, { headers: { apikey: this.env.EVOLUTION_API_KEY } });
      const result = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) return { configured: true, reachable: false, healthy: false, enabled: false, message: `Evolution respondeu ${response.status}` };
      const webhook = result.webhook && typeof result.webhook === "object" ? result.webhook as Record<string, unknown> : result;
      const configuredUrl = String(webhook.url ?? webhook.webhookUrl ?? "").replace(/\/$/, "");
      const events = Array.isArray(webhook.events) ? webhook.events.map(normalizeEvent) : [];
      const enabled = webhook.enabled !== false && Boolean(configuredUrl);
      const healthy = enabled && configuredUrl === expectedUrl && events.includes("MESSAGES_UPSERT");
      return {
        configured: Boolean(configuredUrl),
        reachable: true,
        healthy,
        enabled,
        message: healthy ? "Recebimento de mensagens ativo" : "Webhook de mensagens precisa ser ativado",
      };
    } catch {
      return { configured: true, reachable: false, healthy: false, enabled: false, message: "Não foi possível verificar o webhook" };
    }
  }

  async configureWebhook(): Promise<EvolutionWebhookState> {
    if (!this.env.EVOLUTION_API_KEY) throw new Error("EVOLUTION_API_KEY não configurada");
    const webhookUrl = this.webhookUrl();
    if (!webhookUrl) throw new Error("PUBLIC_API_URL não configurada");
    const url = `${this.env.EVOLUTION_API_URL.replace(/\/$/, "")}/webhook/set/${encodeURIComponent(this.env.EVOLUTION_INSTANCE_NAME)}`;
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: this.env.EVOLUTION_API_KEY },
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: webhookUrl,
          headers: { "x-webhook-secret": this.env.EVOLUTION_WEBHOOK_SECRET },
          byEvents: false,
          base64: false,
          events: ["MESSAGES_UPSERT"],
        },
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Não foi possível ativar o webhook (${response.status}): ${JSON.stringify(result)}`);
    return this.webhookStatus();
  }

  private webhookUrl(): string {
    const publicUrl = (this.env.PUBLIC_API_URL || `${this.env.EVOLUTION_API_URL.replace(/\/$/, "")}/bioecos`).trim().replace(/\/$/, "");
    return publicUrl ? `${publicUrl}/webhooks/evolution` : "";
  }
}

function normalizeEvent(event: unknown): string {
  return String(event).toUpperCase().replace(/[.-]/g, "_");
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
