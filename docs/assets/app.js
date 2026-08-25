const configuredBaseUrl = String(window.BIOECOS_CONFIG?.apiBaseUrl ?? "").replace(/\/$/, "");
const API_BASE_URL = configuredBaseUrl || (location.hostname === "localhost" ? "http://localhost:3000" : "");
const SESSION_KEY = "bioecos_dashboard_session";

const byId = (id) => document.getElementById(id);
const loginView = byId("login-view");
const dashboardView = byId("dashboard-view");
const loginForm = byId("login-form");
const loginError = byId("login-error");
const loginSubmit = byId("login-submit");
let refreshTimer = null;

byId("toggle-password")?.addEventListener("click", () => toggleVisibility("password", "toggle-password"));
byId("toggle-api-key")?.addEventListener("click", () => toggleVisibility("openai-key", "toggle-api-key"));
byId("logout-button")?.addEventListener("click", logout);
byId("refresh-button")?.addEventListener("click", refreshOverview);
byId("openai-form")?.addEventListener("submit", saveOpenAIKey);
byId("remove-api-key")?.addEventListener("click", removeOpenAIKey);
byId("connect-whatsapp")?.addEventListener("click", connectWhatsApp);

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => showSection(button.dataset.section));
});

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setFeedback(loginError, "", "");
  const username = byId("username").value.trim();
  const password = byId("password").value;
  if (!username || !password) {
    setFeedback(loginError, "Informe usuário e senha.", "error");
    return;
  }
  loginSubmit.disabled = true;
  loginSubmit.firstChild.textContent = "Entrando... ";
  try {
    const result = await api("/dashboard/auth/login", {
      method: "POST",
      body: { username, password },
      authenticated: false,
    });
    sessionStorage.setItem(SESSION_KEY, result.token);
    byId("password").value = "";
    byId("operator-name").textContent = result.user.username;
    showDashboard();
    await refreshOverview();
  } catch (error) {
    setFeedback(loginError, error.message, "error");
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.firstChild.textContent = "Acessar painel ";
  }
});

async function api(path, options = {}) {
  if (!API_BASE_URL) throw new Error("A API segura do painel ainda não está publicada.");
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  if (options.authenticated !== false) {
    const token = sessionStorage.getItem(SESSION_KEY);
    if (!token) throw new Error("Sua sessão expirou. Entre novamente.");
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401 && options.authenticated !== false) {
    logout();
    throw new Error("Sua sessão expirou. Entre novamente.");
  }
  if (!response.ok) throw new Error(result.error ?? `Falha na comunicação (${response.status})`);
  return result;
}

async function restoreSession() {
  if (!sessionStorage.getItem(SESSION_KEY)) return;
  try {
    const session = await api("/dashboard/auth/session");
    byId("operator-name").textContent = session.user.username;
    showDashboard();
    await refreshOverview();
  } catch {
    logout();
  }
}

function showDashboard() {
  loginView.hidden = true;
  dashboardView.hidden = false;
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshOverview, 15_000);
}

function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  clearInterval(refreshTimer);
  dashboardView.hidden = true;
  loginView.hidden = false;
  byId("password")?.focus();
}

async function refreshOverview() {
  const button = byId("refresh-button");
  button.classList.add("loading");
  try {
    const overview = await api("/dashboard/overview");
    renderOverview(overview);
    byId("global-alert").hidden = true;
  } catch (error) {
    const alert = byId("global-alert");
    alert.textContent = `Não foi possível atualizar o painel: ${error.message}`;
    alert.hidden = false;
  } finally {
    button.classList.remove("loading");
  }
}

function renderOverview(overview) {
  const { services = {}, metrics = {} } = overview;
  setService("api", Boolean(services.api), services.api ? "Operacional" : "Indisponível");
  setService("database", Boolean(services.database), services.database ? "Conectado" : "Indisponível");
  setService("ai", Boolean(services.ai?.configured), services.ai?.configured ? "Configurada" : "Configuração pendente");
  byId("ai-model").textContent = services.ai?.model || "OpenAI";

  const whatsappConnected = services.whatsapp?.state === "open";
  const whatsappReachable = Boolean(services.whatsapp?.reachable);
  setService("whatsapp", whatsappConnected, whatsappConnected ? "Conectado" : (whatsappReachable ? "Desconectado" : "Indisponível"), whatsappReachable && !whatsappConnected);
  setBadge("whatsapp-badge", whatsappConnected ? "Conectado" : "Desconectado", whatsappConnected ? "ok" : "neutral");
  setBadge("integration-wa-state", whatsappConnected ? "Conectado" : "Desconectado", whatsappConnected ? "ok" : "neutral");

  const aiConfigured = Boolean(services.ai?.configured);
  setBadge("ai-badge", aiConfigured ? "Configurada" : "Pendente", aiConfigured ? "ok" : "warning");
  setBadge("integration-ai-state", aiConfigured ? "Configurada" : "Pendente", aiConfigured ? "ok" : "warning");
  byId("remove-api-key").hidden = !aiConfigured;
  byId("connect-whatsapp").disabled = !aiConfigured || whatsappConnected;
  byId("connect-whatsapp").textContent = whatsappConnected ? "WhatsApp conectado" : "Gerar QR Code";

  renderPipeline(Array.isArray(metrics.stages) ? metrics.stages : []);
  const conversations = Array.isArray(metrics.recentConversations) ? metrics.recentConversations : [];
  renderConversations(byId("conversation-list"), conversations.slice(0, 5));
  renderConversations(byId("conversation-list-full"), conversations);
  byId("last-update").textContent = `Atualizado ${formatTime(overview.checkedAt)}`;
}

async function saveOpenAIKey(event) {
  event.preventDefault();
  const input = byId("openai-key");
  const button = byId("save-api-key");
  const feedback = byId("key-feedback");
  const apiKey = input.value.trim();
  if (apiKey.length < 20) {
    setFeedback(feedback, "Informe uma chave OpenAI válida.", "error");
    return;
  }
  button.disabled = true;
  button.textContent = "Validando...";
  setFeedback(feedback, "", "");
  try {
    await api("/dashboard/settings/openai-key", { method: "PUT", body: { apiKey } });
    input.value = "";
    input.type = "password";
    byId("toggle-api-key").textContent = "Mostrar";
    setFeedback(feedback, "Chave validada e armazenada com criptografia.", "success");
    await refreshOverview();
  } catch (error) {
    setFeedback(feedback, error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Validar e salvar";
  }
}

async function removeOpenAIKey() {
  if (!window.confirm("Remover a chave desativa imediatamente as respostas da IA. Continuar?")) return;
  try {
    await api("/dashboard/settings/openai-key", { method: "DELETE" });
    setFeedback(byId("key-feedback"), "Chave removida. A IA foi desativada.", "success");
    await refreshOverview();
  } catch (error) {
    setFeedback(byId("key-feedback"), error.message, "error");
  }
}

async function connectWhatsApp() {
  const button = byId("connect-whatsapp");
  const feedback = byId("whatsapp-feedback");
  button.disabled = true;
  button.textContent = "Gerando QR Code...";
  try {
    const result = await api("/dashboard/whatsapp/connect", { method: "POST" });
    byId("qr-image").src = result.base64;
    byId("qr-area").hidden = false;
    byId("whatsapp-disconnected").hidden = true;
    setFeedback(feedback, "Escaneie o QR Code antes que ele expire.", "success");
  } catch (error) {
    setFeedback(feedback, error.message, "error");
    button.disabled = false;
  } finally {
    button.textContent = "Gerar novo QR Code";
  }
}

function renderPipeline(stages) {
  const container = byId("pipeline-list");
  container.replaceChildren();
  if (!stages.length) return container.append(emptyState("Nenhum lead registrado."));
  const maximum = Math.max(...stages.map((stage) => Number(stage.total) || 0), 1);
  stages.forEach((stage) => {
    const row = document.createElement("div");
    row.className = "pipeline-row";
    const name = document.createElement("span");
    name.textContent = String(stage.name ?? "Etapa");
    const bar = document.createElement("div");
    bar.className = "pipeline-bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(3, ((Number(stage.total) || 0) / maximum) * 100)}%`;
    bar.append(fill);
    const total = document.createElement("b");
    total.textContent = String(Number(stage.total) || 0);
    row.append(name, bar, total);
    container.append(row);
  });
}

function renderConversations(container, conversations) {
  container.replaceChildren();
  if (!conversations.length) return container.append(emptyState("Nenhuma conversa registrada."));
  conversations.forEach((conversation) => {
    const row = document.createElement("div");
    row.className = "conversation-row";
    const avatar = document.createElement("span");
    avatar.className = "conversation-avatar";
    avatar.textContent = String(conversation.name ?? "C").charAt(0).toUpperCase();
    const identity = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = String(conversation.name || "Contato sem nome");
    const phone = document.createElement("small");
    phone.textContent = maskPhone(String(conversation.phone ?? ""));
    identity.append(name, phone);
    const status = document.createElement("span");
    status.className = conversation.automation_paused ? "conversation-paused" : "conversation-time";
    status.textContent = conversation.automation_paused ? "Em atendimento humano" : formatTime(conversation.last_interaction_at);
    row.append(avatar, identity, status);
    container.append(row);
  });
}

function showSection(section) {
  document.querySelectorAll(".dashboard-section").forEach((element) => { element.hidden = element.id !== `section-${section}`; });
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.section === section));
}

function setService(id, ok, label, warning = false) {
  byId(`${id}-status`).textContent = label;
  const dot = byId(`${id}-dot`);
  dot.className = ok ? "ok" : (warning ? "warning" : "");
}

function setBadge(id, label, state) {
  const badge = byId(id);
  badge.textContent = label;
  badge.className = `badge ${state}`;
}

function setFeedback(element, message, state) {
  element.textContent = message;
  element.hidden = !message;
  element.className = element.id === "login-error" ? `form-error ${state}` : `inline-feedback ${state}`;
}

function toggleVisibility(inputId, buttonId) {
  const input = byId(inputId);
  const button = byId(buttonId);
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  button.textContent = visible ? "Mostrar" : "Ocultar";
}

function emptyState(text) {
  const element = document.createElement("p");
  element.className = "empty-state";
  element.textContent = text;
  return element;
}

function formatTime(value) {
  if (!value) return "agora";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "agora" : new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function maskPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return "Número protegido";
  return `${digits.slice(0, 4)}••••${digits.slice(-4)}`;
}

restoreSession();
