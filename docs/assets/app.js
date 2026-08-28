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
let openedHash = "";

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
  byId("whatsapp-disconnected").hidden = whatsappConnected;

  const aiBadgeState = aiOperational ? "ok" : (aiHealth.state === "insufficient_quota" || aiHealth.state === "invalid_key" ? "danger" : "warning");
  setBadge("ai-badge", aiConfigured ? (aiLabels[aiHealth.state] ?? "Requer atenção") : "Obrigatória", aiBadgeState);
  setBadge("integration-ai-state", aiConfigured ? (aiLabels[aiHealth.state] ?? "Requer atenção") : "Obrigatória", aiBadgeState);
  byId("remove-api-key").hidden = !aiConfigured;
  byId("connect-whatsapp").disabled = whatsappConnected;
  byId("connect-whatsapp").textContent = whatsappConnected ? "WhatsApp conectado" : "Gerar QR Code";
  setBadge("integration-coordinator-state", services.coordinator?.configured ? "Configurado" : "Pendente", services.coordinator?.configured ? "ok" : "warning");

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
    setFeedback(byId("coordinator-feedback"), `Número salvo (${result.masked}).`, "success");
    await refreshOverview();
  } catch (error) {
    setFeedback(byId("coordinator-feedback"), error.message, "error");
  } finally {
    button.disabled = false;
  }
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
  [["coordinator_attending", "Assumir atendimento"], ["ai_attending", "Devolver para IA"], ["enrollment_completed", "Matrícula concluída"], ["not_interested", "Sem interesse"], ["conversation_finished", "Finalizar conversa"]].forEach(([state, label]) => {
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
