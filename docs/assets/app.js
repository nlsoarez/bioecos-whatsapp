const configuredBaseUrl = String(window.BIOECOS_CONFIG?.apiBaseUrl ?? "").replace(/\/$/, "");
const API_BASE_URL = configuredBaseUrl || (location.hostname === "localhost" ? "http://localhost:3000" : "");
const SESSION_KEY = "bioecos_dashboard_session";
const QR_REFRESH_INTERVAL_MS = 4_000;
const QR_SESSION_TIMEOUT_MS = 2 * 60_000;

const byId = (id) => document.getElementById(id);
const loginView = byId("login-view");
const dashboardView = byId("dashboard-view");
const loginForm = byId("login-form");
const loginError = byId("login-error");
const loginSubmit = byId("login-submit");
let refreshTimer = null;
let qrRefreshTimer = null;
let qrCountdownTimer = null;
let qrSessionStartedAt = 0;
let qrExpiresAt = 0;
let qrCurrentBase64 = "";
let qrSessionActive = false;
let qrRefreshInFlight = false;
let qrSessionGeneration = 0;
let openedHash = "";
let ignoredNumbers = [];
let knowledgeEntries = [];
let knowledgeMedia = [];
let mediaObjectUrls = [];

byId("toggle-password")?.addEventListener("click", () => toggleVisibility("password", "toggle-password"));
byId("toggle-api-key")?.addEventListener("click", () => toggleVisibility("openai-key", "toggle-api-key"));
byId("logout-button")?.addEventListener("click", () => void revokeSession());
byId("refresh-button")?.addEventListener("click", refreshOverview);
byId("openai-form")?.addEventListener("submit", saveOpenAIKey);
byId("remove-api-key")?.addEventListener("click", removeOpenAIKey);
byId("test-openai-credit")?.addEventListener("click", testOpenAICredit);
byId("connect-whatsapp")?.addEventListener("click", connectWhatsApp);
byId("repair-webhook")?.addEventListener("click", repairWebhook);
byId("toggle-followup")?.addEventListener("click", toggleMonthlyFollowup);
byId("coordinator-form")?.addEventListener("submit", saveCoordinatorPhone);
byId("notification-status-filter")?.addEventListener("change", () => void loadNotificationHistory());
byId("ignored-number-form")?.addEventListener("submit", saveIgnoredNumber);
byId("cancel-ignored-edit")?.addEventListener("click", resetIgnoredNumberForm);
byId("ignored-search")?.addEventListener("input", debounce(() => void loadIgnoredNumbers(), 250));
document.querySelectorAll(".knowledge-tabs button").forEach((button) => button.addEventListener("click", () => showKnowledgeTab(button.dataset.knowledgeTab)));
byId("knowledge-form")?.addEventListener("submit", saveKnowledge);
byId("cancel-knowledge-edit")?.addEventListener("click", resetKnowledgeForm);
byId("knowledge-kind")?.addEventListener("change", updateCourseFieldsVisibility);
byId("knowledge-search")?.addEventListener("input", debounce(() => void loadKnowledge(), 250));
byId("knowledge-filter-kind")?.addEventListener("change", () => void loadKnowledge());
byId("knowledge-document-form")?.addEventListener("submit", uploadKnowledgeDocument);
byId("knowledge-image-form")?.addEventListener("submit", saveKnowledgeImage);
byId("cancel-image-edit")?.addEventListener("click", resetKnowledgeImageForm);
byId("image-search")?.addEventListener("input", debounce(() => void loadKnowledgeMedia(), 250));
byId("knowledge-test-form")?.addEventListener("submit", testKnowledge);
document.querySelectorAll("#lead-filters button").forEach((button) => {
  button.addEventListener("click", () => loadLeads(button.dataset.filter));
});

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
    await openConversationFromHash();
  } catch (error) {
    setFeedback(loginError, error.message, "error");
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.firstChild.textContent = "Acessar painel ";
  }
});

async function api(path, options = {}) {
  if (!API_BASE_URL) throw new Error("A API segura do painel ainda não está publicada.");
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
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

async function apiBlob(path) {
  const token = sessionStorage.getItem(SESSION_KEY);
  if (!token) throw new Error("Sua sessão expirou. Entre novamente.");
  const response = await fetch(`${API_BASE_URL}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401) { logout(); throw new Error("Sua sessão expirou. Entre novamente."); }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error ?? `Falha na comunicação (${response.status})`);
  }
  return response.blob();
}

async function restoreSession() {
  if (!sessionStorage.getItem(SESSION_KEY)) return;
  try {
    const session = await api("/dashboard/auth/session");
    byId("operator-name").textContent = session.user.username;
    showDashboard();
    await refreshOverview();
    await openConversationFromHash();
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
  stopQrSession();
  sessionStorage.removeItem(SESSION_KEY);
  clearInterval(refreshTimer);
  dashboardView.hidden = true;
  loginView.hidden = false;
  byId("password")?.focus();
}

async function revokeSession() {
  try {
    if (sessionStorage.getItem(SESSION_KEY)) {
      await api("/dashboard/auth/logout", { method: "POST" });
    }
  } catch {
    // O encerramento local ainda ocorre se a API estiver indisponível.
  } finally {
    logout();
  }
}

async function refreshOverview() {
  const button = byId("refresh-button");
  button.classList.add("loading");
  try {
    const overview = await api("/dashboard/overview");
    renderOverview(overview);
    await loadNotificationFailures();
  } catch (error) {
    const alert = byId("global-alert");
    alert.textContent = `Não foi possível atualizar o painel: ${error.message}`;
    alert.hidden = false;
  } finally {
    button.classList.remove("loading");
  }
}

async function loadNotificationFailures() {
  const container = byId("notification-failures");
  try {
    const result = await api("/dashboard/notifications/failed");
    const notifications = Array.isArray(result.notifications) ? result.notifications : [];
    container.replaceChildren();
    container.hidden = notifications.length === 0;
    if (!notifications.length) return;
    const text = document.createElement("span");
    text.textContent = `${notifications.length} notificação(ões) ao coordenador falharam. `;
    container.append(text);
    notifications.slice(0, 5).forEach((notification) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-action";
      button.textContent = "Tentar novamente";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await api(`/dashboard/notifications/${encodeURIComponent(notification.id)}/retry`, { method: "POST" }); await loadNotificationFailures(); }
        catch (error) { window.alert(error.message); }
        finally { button.disabled = false; }
      });
      container.append(button);
    });
  } catch {
    container.hidden = true;
  }
}

function renderOverview(overview) {
  const { services = {}, metrics = {} } = overview;
  const operations = overview.operations ?? {};
  const operationalProblems = [];
  if (Number(operations.embeddings?.pending) > 0) operationalProblems.push(`${operations.embeddings.pending} trecho(s) aguardando vetorização`);
  if (Number(operations.queue?.failed) > 0) operationalProblems.push(`${operations.queue.failed} webhook(s) em falha definitiva`);
  const operationalAlert = byId("global-alert");
  operationalAlert.replaceChildren();
  operationalAlert.hidden = operationalProblems.length === 0;
  if (operationalProblems.length) {
    const text = document.createElement("span"); text.textContent = `Atenção operacional: ${operationalProblems.join("; ")}. `; operationalAlert.append(text);
    if (Number(operations.queue?.failed) > 0) {
      const retry = document.createElement("button"); retry.type = "button"; retry.className = "secondary-action"; retry.textContent = "Reprocessar webhooks";
      retry.addEventListener("click", async () => { retry.disabled = true; try { await api("/dashboard/webhooks/retry-failed", { method: "POST" }); await refreshOverview(); } catch (error) { window.alert(error.message); } });
      operationalAlert.append(retry);
    }
  }
  setService("api", Boolean(services.api), services.api ? "Operacional" : "Indisponível");
  setService("database", Boolean(services.database), services.database ? "Conectado" : "Indisponível");
  const aiConfigured = Boolean(services.ai?.configured);
  const aiHealth = services.ai?.health ?? { state: "not_tested", message: "Crédito ainda não testado" };
  const aiLabels = {
    not_configured: "Chave não configurada",
    operational: "Operacional",
    insufficient_quota: "Sem crédito",
    invalid_key: "Chave inválida",
    rate_limited: "Limite temporário",
    unavailable: "Indisponível",
    not_tested: aiConfigured ? "Crédito não testado" : "Chave obrigatória",
  };
  const aiOperational = aiConfigured && aiHealth.state === "operational";
  setService("ai", aiOperational, aiLabels[aiHealth.state] ?? "Requer atenção", aiConfigured && aiHealth.state === "not_tested");
  byId("ai-model").textContent = `Somente IA · ${services.ai?.model || "OpenAI"}`;
  byId("openai-credit-status").textContent = aiConfigured ? (aiLabels[aiHealth.state] ?? "Requer atenção") : "Chave não configurada";
  byId("openai-credit-detail").textContent = aiConfigured ? aiHealth.message : "Configure uma chave para testar.";
  byId("test-openai-credit").disabled = !aiConfigured;

  const whatsappConnected = services.whatsapp?.state === "open";
  const whatsappReachable = Boolean(services.whatsapp?.reachable);
  const webhookHealthy = Boolean(services.whatsapp?.webhook?.healthy);
  const whatsappOperational = whatsappConnected && webhookHealthy;
  setService("whatsapp", whatsappOperational, whatsappOperational ? "Operacional" : (whatsappConnected ? "Webhook pendente" : (whatsappReachable ? "Desconectado" : "Indisponível")), whatsappConnected && !webhookHealthy);
  setBadge("whatsapp-badge", whatsappOperational ? "Operacional" : (whatsappConnected ? "Recebimento pendente" : "Desconectado"), whatsappOperational ? "ok" : (whatsappConnected ? "warning" : "neutral"));
  setBadge("integration-wa-state", whatsappOperational ? "Operacional" : (whatsappConnected ? "Webhook pendente" : "Desconectado"), whatsappOperational ? "ok" : (whatsappConnected ? "warning" : "neutral"));
  byId("whatsapp-webhook-status").textContent = services.whatsapp?.webhook?.message ?? "Recebimento ainda não verificado";
  byId("repair-webhook").hidden = !whatsappConnected || webhookHealthy;
  if (whatsappConnected && qrSessionActive) {
    stopQrSession();
    setFeedback(byId("whatsapp-feedback"), "WhatsApp conectado. O QR Code foi removido.", "success");
  }
  byId("whatsapp-disconnected").hidden = whatsappConnected || qrSessionActive;

  const aiBadgeState = aiOperational ? "ok" : (aiHealth.state === "insufficient_quota" || aiHealth.state === "invalid_key" ? "danger" : "warning");
  setBadge("ai-badge", aiConfigured ? (aiLabels[aiHealth.state] ?? "Requer atenção") : "Obrigatória", aiBadgeState);
  setBadge("integration-ai-state", aiConfigured ? (aiLabels[aiHealth.state] ?? "Requer atenção") : "Obrigatória", aiBadgeState);
  byId("remove-api-key").hidden = !aiConfigured;
  byId("connect-whatsapp").disabled = whatsappConnected || qrSessionActive;
  byId("connect-whatsapp").textContent = whatsappConnected ? "WhatsApp conectado" : (qrSessionActive ? "Aguardando conexão..." : "Gerar QR Code");
  setBadge("integration-coordinator-state", services.coordinator?.configured ? "Configurado" : "Pendente", services.coordinator?.configured ? "ok" : "warning");
  renderCoordinatorPhone(services.coordinator?.masked ?? null);

  renderPipeline(Array.isArray(metrics.stages) ? metrics.stages : []);
  renderFollowup(metrics.followup ?? {}, metrics.followupSettings ?? {});
  const conversations = Array.isArray(metrics.recentConversations) ? metrics.recentConversations : [];
  renderConversations(byId("conversation-list"), conversations.slice(0, 5));
  renderConversations(byId("conversation-list-full"), conversations);
  byId("last-update").textContent = `Atualizado ${formatTime(overview.checkedAt)}`;
}

function renderFollowup(metrics, settings) {
  const enabled = Boolean(settings.enabled);
  setBadge("followup-badge", enabled ? "Ativo" : "Inativo", enabled ? "ok" : "neutral");
  byId("followup-hot").textContent = String(Number(metrics.hot_leads) || 0);
  byId("followup-eligible").textContent = String(Number(metrics.eligible_leads) || 0);
  byId("followup-sent").textContent = String(Number(metrics.sent_last_30_days) || 0);
  byId("followup-optouts").textContent = String(Number(metrics.opt_outs) || 0);
  const button = byId("toggle-followup");
  button.dataset.enabled = String(enabled);
  button.textContent = enabled ? "Desativar acompanhamento" : "Ativar acompanhamento";
  button.classList.toggle("danger-action", enabled);
}

async function toggleMonthlyFollowup() {
  const button = byId("toggle-followup");
  const currentlyEnabled = button.dataset.enabled === "true";
  if (!currentlyEnabled && !window.confirm("Ao ativar, leads quentes elegíveis poderão receber até três mensagens automáticas nos dias 30, 60 e 90. Deseja ativar?")) return;
  button.disabled = true;
  try {
    await api("/dashboard/settings/monthly-followup", { method: "PUT", body: { enabled: !currentlyEnabled } });
    setFeedback(byId("followup-feedback"), currentlyEnabled ? "Acompanhamento 30/60/90 desativado." : "Acompanhamento 30/60/90 ativado.", "success");
    await refreshOverview();
  } catch (error) {
    setFeedback(byId("followup-feedback"), error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function saveCoordinatorPhone(event) {
  event.preventDefault();
  const input = byId("coordinator-phone");
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const result = await api("/dashboard/settings/coordinator-phone", { method: "PUT", body: { phone: input.value } });
    input.value = "";
    renderCoordinatorPhone(result.masked ?? null);
    setFeedback(byId("coordinator-feedback"), `Número salvo (${result.masked}).`, "success");
    await refreshOverview();
  } catch (error) {
    setFeedback(byId("coordinator-feedback"), error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function renderCoordinatorPhone(masked) {
  const identification = byId("coordinator-phone-identification");
  if (!identification) return;
  identification.textContent = masked ? `Número configurado: ${masked}` : "Nenhum número configurado";
}

async function loadLeads(filter = "all") {
  document.querySelectorAll("#lead-filters button").forEach((button) => button.classList.toggle("active", button.dataset.filter === filter));
  const feedback = byId("leads-feedback");
  const table = byId("leads-table");
  feedback.hidden = false;
  feedback.textContent = "Carregando leads...";
  table.hidden = true;
  try {
    const result = await api(`/dashboard/leads?filter=${encodeURIComponent(filter)}`);
    renderLeads(Array.isArray(result.leads) ? result.leads : []);
  } catch (error) {
    feedback.textContent = `Não foi possível carregar os leads: ${error.message}`;
  }
}

function renderLeads(leads) {
  const feedback = byId("leads-feedback");
  const table = byId("leads-table");
  table.replaceChildren();
  if (!leads.length) {
    feedback.hidden = false;
    feedback.textContent = "Nenhum lead encontrado neste filtro.";
    table.hidden = true;
    return;
  }
  feedback.hidden = true;
  table.hidden = false;
  const header = document.createElement("div");
  header.className = "lead-row lead-head";
  ["Nome", "Curso/serviço", "Classificação", "Estado", "Última interação", "Próximo follow-up", "Responsável", "Entrada"].forEach((label) => {
    const cell = document.createElement("span"); cell.textContent = label; header.append(cell);
  });
  table.append(header);
  leads.forEach((lead) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `lead-row ${lead.temperature === "hot" || lead.workflow_state === "awaiting_coordinator" ? "priority" : ""}`;
    row.addEventListener("click", () => loadLeadDetail(lead.contact_id));
    [lead.name || "Sem nome", lead.course || "Em identificação", temperatureLabel(lead.temperature), workflowLabel(lead.workflow_state),
      formatDateTime(lead.last_interaction_at), lead.followup_next_at ? formatDateTime(lead.followup_next_at) : "—",
      lead.current_owner === "ai" ? "IA" : "Coordenador", lead.source || "WhatsApp"].forEach((value) => {
      const cell = document.createElement("span"); cell.textContent = String(value); row.append(cell);
    });
    table.append(row);
  });
}

async function loadLeadDetail(contactId) {
  const detail = byId("lead-detail");
  detail.hidden = false;
  detail.replaceChildren(emptyState("Carregando histórico..."));
  try {
    const { lead } = await api(`/dashboard/leads/${encodeURIComponent(contactId)}`);
    renderLeadDetail(lead);
    detail.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    detail.replaceChildren(emptyState(`Falha ao carregar: ${error.message}`));
  }
}

function renderLeadDetail(lead) {
  const detail = byId("lead-detail");
  detail.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "panel-heading";
  const title = document.createElement("h2"); title.textContent = lead.name || "Contato sem nome";
  const badge = document.createElement("span"); badge.className = `badge ${lead.temperature === "hot" ? "danger" : lead.temperature === "warm" ? "warning" : "neutral"}`; badge.textContent = temperatureLabel(lead.temperature);
  heading.append(title, badge);
  const meta = document.createElement("p"); meta.className = "panel-description";
  meta.textContent = `${lead.course || lead.interest || "Interesse em identificação"} · ${workflowLabel(lead.workflow_state)} · responsável: ${lead.current_owner === "ai" ? "IA" : "Coordenador"}`;
  const summary = document.createElement("p"); summary.className = "lead-summary"; summary.textContent = lead.summary || "Resumo ainda não gerado.";
  const actions = document.createElement("div"); actions.className = "lead-actions";
  [["coordinator_attending", "Assumir atendimento"], ["ai_attending", "Devolver atendimento para Débora"], ["enrollment_completed", "Matrícula concluída"], ["not_interested", "Sem interesse"], ["conversation_finished", "Finalizar conversa"]].forEach(([state, label]) => {
    const button = document.createElement("button"); button.type = "button"; button.className = state === "enrollment_completed" ? "primary-action" : "secondary-action"; button.textContent = label;
    button.addEventListener("click", () => changeWorkflow(lead.conversation_id, state, label)); actions.append(button);
  });
  const exportButton = document.createElement("button"); exportButton.type = "button"; exportButton.className = "secondary-action"; exportButton.textContent = "Exportar dados";
  exportButton.addEventListener("click", () => exportLead(lead.id)); actions.append(exportButton);
  const deleteButton = document.createElement("button"); deleteButton.type = "button"; deleteButton.className = "secondary-action danger-action"; deleteButton.textContent = "Excluir dados";
  deleteButton.addEventListener("click", () => deleteLead(lead.id)); actions.append(deleteButton);
  const history = document.createElement("div"); history.className = "message-history";
  (lead.history || []).slice().reverse().forEach((message) => {
    const item = document.createElement("div"); item.className = `message-item ${message.direction}`;
    const content = document.createElement("p"); content.textContent = message.content;
    const time = document.createElement("small"); time.textContent = formatDateTime(message.timestamp);
    item.append(content, time); history.append(item);
  });
  if (!history.children.length) history.append(emptyState("Sem mensagens registradas."));
  detail.append(heading, meta, summary, actions, history);
}

async function openConversationFromHash() {
  const match = location.hash.match(/^#conversation-([0-9a-f-]{36})$/i);
  if (!match || openedHash === location.hash) return;
  openedHash = location.hash;
  try {
    const { lead } = await api(`/dashboard/conversations/${encodeURIComponent(match[1])}`);
    showSection("leads");
    renderLeadDetail(lead);
    byId("lead-detail").hidden = false;
    byId("lead-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    window.alert(`Não foi possível abrir a conversa: ${error.message}`);
  }
}

async function exportLead(contactId) {
  try {
    const data = await api(`/dashboard/leads/${encodeURIComponent(contactId)}/export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `lead-${contactId}.json`; link.click();
    URL.revokeObjectURL(url);
  } catch (error) { window.alert(error.message); }
}

async function deleteLead(contactId) {
  if (!window.confirm("Esta ação exclui definitivamente o contato, conversas, mensagens e histórico associado. Deseja continuar?")) return;
  const confirmation = window.prompt("Digite EXCLUIR para confirmar:");
  if (confirmation !== "EXCLUIR") return;
  try {
    await api(`/dashboard/leads/${encodeURIComponent(contactId)}`, { method: "DELETE", body: { confirm: "EXCLUIR" } });
    byId("lead-detail").hidden = true;
    await loadLeads(document.querySelector("#lead-filters button.active")?.dataset.filter || "all");
  } catch (error) { window.alert(error.message); }
}

async function changeWorkflow(conversationId, state, label) {
  try {
    await api(`/dashboard/conversations/${encodeURIComponent(conversationId)}/workflow`, { method: "PATCH", body: { state, reason: `Ação manual no portal: ${label}` } });
    await loadLeads(document.querySelector("#lead-filters button.active")?.dataset.filter || "all");
    byId("lead-detail").hidden = true;
  } catch (error) {
    window.alert(error.message);
  }
}

async function testOpenAICredit() {
  const button = byId("test-openai-credit");
  button.disabled = true;
  button.textContent = "Testando...";
  try {
    const health = await api("/dashboard/openai/test", { method: "POST" });
    setFeedback(byId("key-feedback"), health.message, health.state === "operational" ? "success" : "error");
    await refreshOverview();
  } catch (error) {
    setFeedback(byId("key-feedback"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Testar agora";
  }
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
  stopQrSession();
  qrSessionActive = true;
  qrSessionStartedAt = Date.now();
  const generation = qrSessionGeneration;
  button.disabled = true;
  button.textContent = "Gerando QR Code...";
  try {
    const result = await api("/dashboard/whatsapp/connect", { method: "POST" });
    if (!qrSessionActive || generation !== qrSessionGeneration) return;
    showQrCode(result);
    byId("whatsapp-disconnected").hidden = true;
    setFeedback(feedback, "Escaneie o QR Code. O portal renovará o código automaticamente.", "success");
    button.textContent = "Aguardando conexão...";
    startQrTimers();
  } catch (error) {
    if (generation !== qrSessionGeneration) return;
    stopQrSession();
    setFeedback(feedback, error.message, "error");
    button.disabled = false;
    button.textContent = "Gerar novo QR Code";
  }
}

function startQrTimers() {
  clearTimeout(qrRefreshTimer);
  clearInterval(qrCountdownTimer);
  qrCountdownTimer = setInterval(updateQrCountdown, 1_000);
  updateQrCountdown();
  qrRefreshTimer = setTimeout(() => void refreshQrSession(), QR_REFRESH_INTERVAL_MS);
}

async function refreshQrSession() {
  if (!qrSessionActive || qrRefreshInFlight) return;
  if (Date.now() - qrSessionStartedAt >= QR_SESSION_TIMEOUT_MS) {
    stopQrSession();
    setFeedback(byId("whatsapp-feedback"), "Tempo de conexão encerrado. Gere um novo QR Code para tentar novamente.", "error");
    return;
  }

  const generation = qrSessionGeneration;
  qrRefreshInFlight = true;
  try {
    const result = await api("/dashboard/whatsapp/qr");
    if (!qrSessionActive || generation !== qrSessionGeneration) return;
    if (result.connection?.state === "open") {
      stopQrSession();
      setFeedback(byId("whatsapp-feedback"), "WhatsApp conectado. O QR Code foi removido.", "success");
      await refreshOverview();
      return;
    }
    if (result.qrCode) showQrCode(result.qrCode);
  } catch (error) {
    if (generation !== qrSessionGeneration) return;
    setFeedback(byId("whatsapp-feedback"), `${error.message} Tentando novamente...`, "error");
  } finally {
    if (generation !== qrSessionGeneration) return;
    qrRefreshInFlight = false;
    if (qrSessionActive) {
      clearTimeout(qrRefreshTimer);
      qrRefreshTimer = setTimeout(() => void refreshQrSession(), QR_REFRESH_INTERVAL_MS);
    }
  }
}

function showQrCode(qrCode) {
  const remainingMs = Number(qrCode.remainingMs);
  if (!Number.isFinite(remainingMs) || remainingMs < 0) throw new Error("A API não informou a validade do QR Code");

  qrExpiresAt = Date.now() + remainingMs;
  const image = byId("qr-image");
  if (qrCode.base64 !== qrCurrentBase64) {
    qrCurrentBase64 = qrCode.base64;
    image.src = qrCode.base64;
  }
  byId("qr-area").hidden = false;
  updateQrCountdown();
}

function updateQrCountdown() {
  if (!qrSessionActive) return;
  const remainingMs = qrExpiresAt - Date.now();
  const image = byId("qr-image");
  const countdown = byId("qr-countdown");
  if (remainingMs <= 0) {
    image.hidden = true;
    image.removeAttribute("src");
    countdown.textContent = "QR Code expirado — aguardando renovação automática...";
    return;
  }
  image.hidden = false;
  countdown.textContent = `Válido por até ${Math.ceil(remainingMs / 1_000)}s · renovação automática ativa`;
}

function stopQrSession() {
  qrSessionGeneration += 1;
  qrSessionActive = false;
  qrRefreshInFlight = false;
  qrSessionStartedAt = 0;
  qrExpiresAt = 0;
  qrCurrentBase64 = "";
  clearTimeout(qrRefreshTimer);
  clearInterval(qrCountdownTimer);
  qrRefreshTimer = null;
  qrCountdownTimer = null;
  const image = byId("qr-image");
  image.hidden = true;
  image.removeAttribute("src");
  byId("qr-area").hidden = true;
  byId("qr-countdown").textContent = "QR Code temporário";
  const button = byId("connect-whatsapp");
  if (button) {
    button.disabled = false;
    button.textContent = "Gerar QR Code";
  }
}

async function repairWebhook() {
  const button = byId("repair-webhook");
  button.disabled = true;
  button.textContent = "Ativando...";
  try {
    const result = await api("/dashboard/whatsapp/webhook", { method: "POST" });
    setFeedback(byId("whatsapp-feedback"), result.message, result.healthy ? "success" : "error");
    await refreshOverview();
  } catch (error) {
    setFeedback(byId("whatsapp-feedback"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Ativar recebimento";
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
  if (section === "leads") loadLeads(document.querySelector("#lead-filters button.active")?.dataset.filter || "all");
  if (section === "ignored-numbers") loadIgnoredNumbers();
  if (section === "knowledge") { void loadKnowledge(); void loadKnowledgeMedia(); }
  if (section === "conversations") void loadNotificationHistory();
}

async function loadNotificationHistory() {
  const container = byId("notification-history");
  if (!container) return;
  container.replaceChildren(emptyState("Carregando transferências..."));
  const status = byId("notification-status-filter")?.value || "";
  try {
    const result = await api(`/dashboard/notifications?status=${encodeURIComponent(status)}&limit=50`);
    const notifications = Array.isArray(result.notifications) ? result.notifications : [];
    container.replaceChildren();
    if (!notifications.length) return container.append(emptyState("Nenhuma transferência encontrada."));
    notifications.forEach((notification) => {
      const row = document.createElement("div"); row.className = "notification-row";
      const main = document.createElement("div");
      const heading = document.createElement("div"); heading.className = "notification-heading";
      const title = document.createElement("strong"); title.textContent = notificationStatusLabel(notification.status);
      const time = document.createElement("span"); time.textContent = formatDateTime(notification.requestedAt);
      heading.append(title, time);
      const message = document.createElement("p"); message.textContent = String(notification.message || "Solicitação registrada").split("\n").slice(0, 5).join(" · ");
      const meta = document.createElement("small");
      meta.textContent = `${notification.recipientMasked || "Coordenador não configurado"} · ${notification.attempts || 0} tentativa(s)${notification.lastError ? ` · ${notification.lastError}` : ""}`;
      main.append(heading, message, meta); row.append(main);
      if (notification.customerAckError) {
        const warning = document.createElement('p'); warning.textContent = notification.customerAckError;
        main.append(warning);
      }
      if (notification.status === "failed") {
        const retry = document.createElement("button"); retry.type = "button"; retry.className = "secondary-action"; retry.textContent = "Tentar novamente";
        retry.addEventListener("click", async () => { retry.disabled = true; try { await api(`/dashboard/notifications/${encodeURIComponent(notification.id)}/retry`, { method: "POST" }); await loadNotificationHistory(); await loadNotificationFailures(); } catch (error) { window.alert(error.message); } finally { retry.disabled = false; } });
        row.append(retry);
      }
      container.append(row);
    });
  } catch (error) { container.replaceChildren(emptyState(error.message)); }
}

function notificationStatusLabel(status) {
  return ({ pending: "Aguardando nova tentativa", processing: "Envio em andamento", accepted: "Aceita pelo WhatsApp — leitura não confirmada", failed: "Falha definitiva" })[status] || "Estado desconhecido";
}

function showKnowledgeTab(tab = "entries") {
  const panelTab = tab === "courses" ? "entries" : tab;
  document.querySelectorAll(".knowledge-tab").forEach((element) => { element.hidden = element.id !== `knowledge-tab-${panelTab}`; });
  document.querySelectorAll(".knowledge-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.knowledgeTab === tab));
  if (tab === "courses") {
    byId("knowledge-kind").value = "course";
    byId("knowledge-filter-kind").value = "course";
    updateCourseFieldsVisibility();
  }
  if (panelTab === "entries") void loadKnowledge();
  if (tab === "images") void loadKnowledgeMedia();
  if (tab === "history") void loadKnowledgeHistory();
}

async function loadKnowledge() {
  const list = byId("knowledge-list");
  if (!list) return;
  list.replaceChildren(emptyState("Carregando conteúdos..."));
  const search = byId("knowledge-search").value.trim();
  const kind = byId("knowledge-filter-kind").value;
  try {
    const result = await api(`/dashboard/knowledge?search=${encodeURIComponent(search)}&kind=${encodeURIComponent(kind)}`);
    knowledgeEntries = Array.isArray(result.entries) ? result.entries : [];
    renderKnowledge();
    populateKnowledgeEntrySelect();
  } catch (error) { list.replaceChildren(emptyState(error.message)); }
}

function renderKnowledge() {
  const list = byId("knowledge-list");
  list.replaceChildren();
  byId("knowledge-count").textContent = String(knowledgeEntries.length);
  if (!knowledgeEntries.length) return list.append(emptyState("Nenhum conteúdo adicional."));
  knowledgeEntries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = `knowledge-row${entry.active ? "" : " inactive"}`;
    const main = document.createElement("div");
    const heading = document.createElement("div");
    heading.className = "knowledge-row-heading";
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const status = document.createElement("span");
    status.className = `badge ${knowledgeStatusClass(entry.status)}`;
    status.textContent = knowledgeStatusLabel(entry.status);
    heading.append(title, status);
    const meta = document.createElement("span");
    meta.className = "knowledge-meta";
    meta.textContent = [knowledgeKindLabel(entry.kind), entry.category, entry.courseName, `${Number(entry.imageCount) || 0} imagem(ns)`].filter(Boolean).join(" · ");
    const summary = document.createElement("p");
    summary.textContent = String(entry.content || "").slice(0, 260);
    main.append(heading, meta, summary);
    if (entry.conflictDetails) {
      const conflict = document.createElement("small"); conflict.className = "knowledge-conflict"; conflict.textContent = entry.conflictDetails; main.append(conflict);
    }
    const actions = document.createElement("div");
    actions.className = "knowledge-row-actions";
    actions.append(
      knowledgeAction(entry.active ? "Desativar" : "Ativar", () => void toggleKnowledge(entry)),
      knowledgeAction("Editar", () => editKnowledge(entry)),
      knowledgeAction("Excluir", () => void deleteKnowledge(entry), true),
    );
    row.append(main, actions);
    list.append(row);
  });
}

function knowledgeAction(label, action, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `secondary-action${danger ? " danger-action" : ""}`;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function knowledgePayload(confirmConflict) {
  const structuredData = {};
  const fields = {
    modality: "course-modality", workload: "course-workload", duration: "course-duration", price: "course-price",
    dates: "course-dates", schedule: "course-schedule", location: "course-location", prerequisites: "course-prerequisites",
    availability: "course-availability", registrationUrl: "course-registration-url",
  };
  Object.entries(fields).forEach(([key, id]) => { structuredData[key] = byId(id).value.trim() || null; });
  return {
    kind: byId("knowledge-kind").value,
    category: byId("knowledge-category").value.trim(),
    title: byId("knowledge-title").value.trim(),
    content: byId("knowledge-content").value.trim(),
    courseName: byId("knowledge-course").value.trim() || null,
    structuredData,
    active: byId("knowledge-active").checked,
    ...(confirmConflict === undefined ? {} : { confirmConflict }),
  };
}

async function saveKnowledge(event) {
  event.preventDefault();
  const currentId = byId("knowledge-id").value;
  const button = byId("save-knowledge");
  const feedback = byId("knowledge-form-feedback");
  button.disabled = true;
  try {
    const path = currentId ? `/dashboard/knowledge/${encodeURIComponent(currentId)}` : "/dashboard/knowledge";
    let result = await api(path, { method: currentId ? "PATCH" : "POST", body: knowledgePayload() });
    if (result.entry?.status === "conflict" && window.confirm(`${result.entry.conflictDetails}\n\nVocê revisou a divergência e deseja publicar mesmo assim?`)) {
      result = await api(`/dashboard/knowledge/${encodeURIComponent(result.entry.id)}`, { method: "PATCH", body: knowledgePayload(true) });
    }
    const conflicted = result.entry?.status === "conflict";
    resetKnowledgeForm();
    setFeedback(feedback, conflicted ? "Conteúdo salvo desativado por possível divergência. Revise antes de ativar." : "Conteúdo salvo. A vetorização será concluída em segundo plano.", conflicted ? "error" : "success");
    await loadKnowledge();
  } catch (error) { setFeedback(feedback, error.message, "error"); }
  finally { button.disabled = false; }
}

function editKnowledge(entry) {
  byId("knowledge-id").value = entry.id;
  byId("knowledge-kind").value = entry.kind;
  byId("knowledge-category").value = entry.category || "Geral";
  byId("knowledge-title").value = entry.title || "";
  byId("knowledge-course").value = entry.courseName || "";
  byId("knowledge-content").value = entry.content || "";
  byId("knowledge-active").checked = Boolean(entry.active);
  const fields = { modality: "course-modality", workload: "course-workload", duration: "course-duration", price: "course-price", dates: "course-dates", schedule: "course-schedule", location: "course-location", prerequisites: "course-prerequisites", availability: "course-availability", registrationUrl: "course-registration-url" };
  Object.entries(fields).forEach(([key, id]) => { byId(id).value = entry.structuredData?.[key] || ""; });
  byId("knowledge-form-title").textContent = "Editar conhecimento";
  byId("save-knowledge").textContent = "Salvar alterações";
  byId("cancel-knowledge-edit").hidden = false;
  updateCourseFieldsVisibility();
  byId("knowledge-title").focus();
}

function resetKnowledgeForm() {
  byId("knowledge-form").reset();
  byId("knowledge-id").value = "";
  byId("knowledge-category").value = "Geral";
  byId("knowledge-active").checked = true;
  byId("knowledge-form-title").textContent = "Adicionar conhecimento";
  byId("save-knowledge").textContent = "Adicionar";
  byId("cancel-knowledge-edit").hidden = true;
  updateCourseFieldsVisibility();
}

function updateCourseFieldsVisibility() { byId("course-fields").hidden = byId("knowledge-kind").value !== "course"; }

async function toggleKnowledge(entry) {
  try {
    const payload = { ...entry, active: !entry.active, structuredData: entry.structuredData || {}, confirmConflict: true };
    await api(`/dashboard/knowledge/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: payload });
    await loadKnowledge();
  } catch (error) { window.alert(error.message); }
}

async function deleteKnowledge(entry) {
  if (!window.confirm(`Excluir “${entry.title}”? O histórico será preservado para auditoria.`)) return;
  try {
    await api(`/dashboard/knowledge/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
    if (byId("knowledge-id").value === entry.id) resetKnowledgeForm();
    await loadKnowledge();
  } catch (error) { window.alert(error.message); }
}

async function uploadKnowledgeDocument(event) {
  event.preventDefault();
  const file = byId("document-file").files[0];
  const button = byId("upload-document");
  const feedback = byId("document-feedback");
  if (!file) return setFeedback(feedback, "Selecione um documento.", "error");
  if (file.size > 4 * 1024 * 1024) return setFeedback(feedback, "O documento excede 4 MB.", "error");
  button.disabled = true;
  try {
    await api("/dashboard/knowledge/documents", { method: "POST", body: {
      filename: file.name, mimeType: file.type || mimeTypeFromFilename(file.name), base64: await fileToBase64(file),
      title: byId("document-title").value.trim(), category: byId("document-category").value.trim(),
      courseName: byId("document-course").value.trim() || null, active: byId("document-active").checked,
    } });
    byId("knowledge-document-form").reset(); byId("document-category").value = "Documentos"; byId("document-active").checked = true;
    setFeedback(feedback, "Documento validado e enviado para indexação.", "success");
    await loadKnowledge();
  } catch (error) { setFeedback(feedback, error.message, "error"); }
  finally { button.disabled = false; }
}

async function loadKnowledgeMedia() {
  const list = byId("image-list");
  if (!list) return;
  list.replaceChildren(emptyState("Carregando imagens..."));
  try {
    const result = await api(`/dashboard/knowledge/media?search=${encodeURIComponent(byId("image-search").value.trim())}`);
    knowledgeMedia = Array.isArray(result.media) ? result.media : [];
    await renderKnowledgeMedia();
  } catch (error) { list.replaceChildren(emptyState(error.message)); }
}

async function renderKnowledgeMedia() {
  const list = byId("image-list");
  mediaObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  mediaObjectUrls = [];
  list.replaceChildren();
  byId("image-count").textContent = String(knowledgeMedia.length);
  if (!knowledgeMedia.length) return list.append(emptyState("Nenhuma imagem cadastrada."));
  for (const item of knowledgeMedia) {
    const card = document.createElement("article");
    card.className = `media-card${item.active ? "" : " inactive"}`;
    const image = document.createElement("img");
    image.className = "media-preview";
    image.alt = item.description;
    image.loading = "lazy";
    try {
      const blob = await apiBlob(`/dashboard/knowledge/media/${encodeURIComponent(item.id)}/file`);
      const url = URL.createObjectURL(blob); mediaObjectUrls.push(url); image.src = url;
    } catch { image.alt = "Imagem indisponível"; }
    const body = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = item.description;
    const meta = document.createElement("small"); meta.textContent = [item.courseName, item.category, formatBytes(item.byteSize), item.active ? "Ativa" : "Inativa"].filter(Boolean).join(" · ");
    const actions = document.createElement("div"); actions.className = "knowledge-row-actions";
    actions.append(
      knowledgeAction(item.active ? "Desativar" : "Ativar", () => void toggleKnowledgeImage(item)),
      knowledgeAction("Editar", () => editKnowledgeImage(item)),
      knowledgeAction("Excluir", () => void deleteKnowledgeImage(item), true),
    );
    body.append(title, meta, actions); card.append(image, body); list.append(card);
  }
}

function imagePayload(item, base64) {
  return {
    entryId: byId("image-entry").value || null,
    courseName: byId("image-course").value.trim() || null,
    category: byId("image-category").value.trim() || "Imagens",
    description: byId("image-description").value.trim(),
    keywords: byId("image-keywords").value.split(",").map((value) => value.trim()).filter(Boolean),
    active: byId("image-active").checked,
    ...(item ? { filename: item.name, mimeType: item.type, base64 } : {}),
  };
}

async function saveKnowledgeImage(event) {
  event.preventDefault();
  const id = byId("image-id").value;
  const file = byId("image-file").files[0];
  const feedback = byId("image-feedback");
  if (!id && !file) return setFeedback(feedback, "Selecione uma imagem.", "error");
  if (file && file.size > 5 * 1024 * 1024) return setFeedback(feedback, "A imagem excede 5 MB.", "error");
  const button = byId("save-image"); button.disabled = true;
  try {
    const base64 = file ? await fileToBase64(file) : undefined;
    await api(id ? `/dashboard/knowledge/media/${encodeURIComponent(id)}` : "/dashboard/knowledge/media", {
      method: id ? "PATCH" : "POST", body: imagePayload(file, base64),
    });
    resetKnowledgeImageForm();
    setFeedback(feedback, id ? "Imagem atualizada." : "Imagem cadastrada e pronta para envio pelo WhatsApp.", "success");
    await loadKnowledgeMedia();
  } catch (error) { setFeedback(feedback, error.message, "error"); }
  finally { button.disabled = false; }
}

function editKnowledgeImage(item) {
  byId("image-id").value = item.id;
  byId("image-description").value = item.description || "";
  byId("image-course").value = item.courseName || "";
  byId("image-category").value = item.category || "Imagens";
  byId("image-keywords").value = Array.isArray(item.keywords) ? item.keywords.join(", ") : "";
  byId("image-entry").value = item.entryId || "";
  byId("image-active").checked = Boolean(item.active);
  byId("save-image").textContent = "Salvar alterações";
  byId("cancel-image-edit").hidden = false;
  byId("image-description").focus();
}

function resetKnowledgeImageForm() {
  byId("knowledge-image-form").reset();
  byId("image-id").value = "";
  byId("image-category").value = "Imagens";
  byId("image-active").checked = true;
  byId("save-image").textContent = "Salvar imagem";
  byId("cancel-image-edit").hidden = true;
}

async function toggleKnowledgeImage(item) {
  try {
    await api(`/dashboard/knowledge/media/${encodeURIComponent(item.id)}`, { method: "PATCH", body: {
      entryId: item.entryId, courseName: item.courseName, category: item.category, description: item.description,
      keywords: item.keywords || [], active: !item.active,
    } });
    await loadKnowledgeMedia();
  } catch (error) { window.alert(error.message); }
}

async function deleteKnowledgeImage(item) {
  if (!window.confirm(`Excluir a imagem “${item.description}”?`)) return;
  try {
    await api(`/dashboard/knowledge/media/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    if (byId("image-id").value === item.id) resetKnowledgeImageForm();
    await loadKnowledgeMedia();
  } catch (error) { window.alert(error.message); }
}

function populateKnowledgeEntrySelect() {
  const select = byId("image-entry");
  if (!select) return;
  const selected = select.value;
  select.replaceChildren();
  const empty = document.createElement("option"); empty.value = ""; empty.textContent = "Sem vínculo"; select.append(empty);
  knowledgeEntries.forEach((entry) => { const option = document.createElement("option"); option.value = entry.id; option.textContent = entry.title; select.append(option); });
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

async function loadKnowledgeHistory() {
  const list = byId("knowledge-history");
  list.replaceChildren(emptyState("Carregando histórico..."));
  try {
    const result = await api("/dashboard/knowledge/history");
    const history = Array.isArray(result.history) ? result.history : [];
    list.replaceChildren();
    if (!history.length) return list.append(emptyState("Nenhuma alteração registrada."));
    history.forEach((version) => {
      const row = document.createElement("div"); row.className = "knowledge-row history-row";
      const body = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = `${version.snapshot?.title || "Conteúdo"} · versão ${version.version}`;
      const meta = document.createElement("span"); meta.className = "knowledge-meta"; meta.textContent = `${version.actor} · ${formatDateTime(version.createdAt)} · ${knowledgeStatusLabel(version.snapshot?.status)}`;
      body.append(title, meta); row.append(body); list.append(row);
    });
  } catch (error) { list.replaceChildren(emptyState(error.message)); }
}

async function testKnowledge(event) {
  event.preventDefault();
  const resultBox = byId("knowledge-test-result");
  const button = byId("run-knowledge-test");
  resultBox.replaceChildren(emptyState("Consultando a base e a IA...")); button.disabled = true;
  try {
    const result = await api("/dashboard/knowledge/test", { method: "POST", body: { question: byId("knowledge-test-question").value.trim() } });
    resultBox.replaceChildren();
    const answer = document.createElement("p"); answer.className = "test-answer"; answer.textContent = result.answer;
    const sourcesTitle = document.createElement("strong"); sourcesTitle.textContent = "Fontes recuperadas";
    const sources = document.createElement("ul");
    (result.sources || []).forEach((source) => { const item = document.createElement("li"); item.textContent = `${source.title} · relevância ${Number(source.score || 0).toFixed(3)}`; sources.append(item); });
    if (!sources.childElementCount) { const item = document.createElement("li"); item.textContent = "Nenhuma fonte recuperada."; sources.append(item); }
    resultBox.append(answer, sourcesTitle, sources);
  } catch (error) { resultBox.replaceChildren(emptyState(error.message)); }
  finally { button.disabled = false; }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

function mimeTypeFromFilename(filename) {
  const extension = String(filename).toLowerCase().split(".").pop();
  return ({ txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })[extension] || "application/octet-stream";
}

function knowledgeStatusLabel(status) { return ({ processing: "Processando", active: "Ativo", inactive: "Inativo", conflict: "Revisão necessária", error: "Erro" })[status] || "Inativo"; }
function knowledgeStatusClass(status) { return status === "active" ? "ok" : status === "processing" ? "warning" : status === "conflict" || status === "error" ? "danger" : "neutral"; }
function knowledgeKindLabel(kind) { return ({ knowledge: "Conhecimento", course: "Curso", qa: "Pergunta e resposta", institutional: "Institucional", rule: "Regra", procedure: "Procedimento", document: "Documento" })[kind] || kind; }
function formatBytes(value) { const bytes = Number(value) || 0; return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }

async function loadIgnoredNumbers() {
  const list = byId("ignored-number-list");
  const search = byId("ignored-search").value.trim();
  list.replaceChildren(emptyState("Carregando números..."));
  try {
    const result = await api(`/dashboard/settings/ignored-numbers?search=${encodeURIComponent(search)}`);
    ignoredNumbers = Array.isArray(result.ignoredNumbers) ? result.ignoredNumbers : [];
    renderIgnoredNumbers();
  } catch (error) {
    list.replaceChildren(emptyState(error.message));
  }
}

function renderIgnoredNumbers() {
  const list = byId("ignored-number-list");
  list.replaceChildren();
  byId("ignored-count").textContent = String(ignoredNumbers.length);
  if (!ignoredNumbers.length) return list.append(emptyState("Nenhum número cadastrado."));
  ignoredNumbers.forEach((item) => {
    const row = document.createElement("div");
    row.className = `ignored-number-row${item.active ? "" : " inactive"}`;
    const main = document.createElement("div");
    main.className = "ignored-number-main";
    const name = document.createElement("strong");
    name.textContent = item.name || "Sem identificação";
    const phone = document.createElement("span");
    phone.textContent = formatCanonicalPhone(item.phoneNumber);
    const note = document.createElement("small");
    note.textContent = item.note || (item.active ? "Bloqueio ativo" : "Bloqueio desativado");
    main.append(name, phone, note);
    const actions = document.createElement("div");
    actions.className = "ignored-number-actions";
    actions.append(
      ignoredAction(item.active ? "Desativar" : "Ativar", () => toggleIgnoredNumber(item)),
      ignoredAction("Editar", () => editIgnoredNumber(item)),
      ignoredAction("Excluir", () => deleteIgnoredNumber(item), true),
    );
    row.append(main, actions);
    list.append(row);
  });
}

function ignoredAction(label, action, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `secondary-action${danger ? " danger-action" : ""}`;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

async function saveIgnoredNumber(event) {
  event.preventDefault();
  const id = byId("ignored-number-id").value;
  const payload = ignoredFormPayload();
  const button = byId("save-ignored-number");
  button.disabled = true;
  try {
    await api(id ? `/dashboard/settings/ignored-numbers/${encodeURIComponent(id)}` : "/dashboard/settings/ignored-numbers", {
      method: id ? "PATCH" : "POST", body: payload,
    });
    resetIgnoredNumberForm();
    setFeedback(byId("ignored-form-feedback"), id ? "Número atualizado." : "Número adicionado à lista protegida.", "success");
    await loadIgnoredNumbers();
  } catch (error) {
    setFeedback(byId("ignored-form-feedback"), error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function editIgnoredNumber(item) {
  byId("ignored-number-id").value = item.id;
  byId("ignored-phone").value = formatCanonicalPhone(item.phoneNumber);
  byId("ignored-name").value = item.name || "";
  byId("ignored-note").value = item.note || "";
  byId("ignored-active").checked = Boolean(item.active);
  byId("ignored-form-title").textContent = "Editar número";
  byId("save-ignored-number").textContent = "Salvar alterações";
  byId("cancel-ignored-edit").hidden = false;
  byId("ignored-phone").focus();
}

async function toggleIgnoredNumber(item) {
  try {
    await api(`/dashboard/settings/ignored-numbers/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      body: { phoneNumber: item.phoneNumber, name: item.name, note: item.note, active: !item.active },
    });
    await loadIgnoredNumbers();
  } catch (error) { window.alert(error.message); }
}

async function deleteIgnoredNumber(item) {
  if (!window.confirm(`Excluir ${formatCanonicalPhone(item.phoneNumber)} da lista de números ignorados?`)) return;
  try {
    await api(`/dashboard/settings/ignored-numbers/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    if (byId("ignored-number-id").value === item.id) resetIgnoredNumberForm();
    await loadIgnoredNumbers();
  } catch (error) { window.alert(error.message); }
}

function ignoredFormPayload() {
  return {
    phoneNumber: byId("ignored-phone").value.trim(),
    name: byId("ignored-name").value.trim() || null,
    note: byId("ignored-note").value.trim() || null,
    active: byId("ignored-active").checked,
  };
}

function resetIgnoredNumberForm() {
  byId("ignored-number-form").reset();
  byId("ignored-number-id").value = "";
  byId("ignored-active").checked = true;
  byId("ignored-form-title").textContent = "Adicionar número";
  byId("save-ignored-number").textContent = "Adicionar número";
  byId("cancel-ignored-edit").hidden = true;
  setFeedback(byId("ignored-form-feedback"), "", "");
}

function formatCanonicalPhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length === 13) return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
  if (digits.startsWith("55") && digits.length === 12) return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 8)}-${digits.slice(8)}`;
  return digits ? `+${digits}` : "—";
}

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
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

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function temperatureLabel(value) { return ({ cold: "Frio", warm: "Morno", hot: "Quente" })[value] || "Frio"; }
function workflowLabel(value) {
  return ({ ai_attending: "IA atendendo", awaiting_coordinator: "Aguardando coordenador", coordinator_attending: "Coordenador atendendo",
    conversation_finished: "Conversa finalizada", enrollment_completed: "Matrícula concluída", not_interested: "Sem interesse" })[value] || value || "IA atendendo";
}

function maskPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return "Número protegido";
  return `${digits.slice(0, 4)}••••${digits.slice(-4)}`;
}

restoreSession();
