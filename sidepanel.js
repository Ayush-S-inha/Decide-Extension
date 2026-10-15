"use strict";

const $ = id => document.getElementById(id);
const ui = {
  goal: $("goalInput"), tabList: $("tabList"), selectedCount: $("selectedCount"),
  make: $("makeDecision"), cancel: $("cancelRun"), progress: $("progressPanel"),
  progressTitle: $("progressTitle"), progressText: $("progressText"), result: $("resultPanel"),
  error: $("errorPanel"), settings: $("settingsPanel"), settingsStatus: $("settingsStatus")
};
let visibleTabs = [];
let runState = null;
const DEFAULT_SETTINGS = {
  ollamaModel: "gpt-oss:120b-cloud",
  geminiModel: "gemini-3.8-flash",
  groqModel: "openai/gpt-oss-120b",
  openRouterModel: "openai/gpt-oss-120b",
  geminiApiKey: "",
  groqApiKey: "",
  openRouterApiKey: ""
};

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return "Website"; }
}

async function loadTabs() {
  ui.tabList.replaceChildren();
  ui.tabList.append(makeEmpty("Loading your open pages…"));
  const [tabs, active] = await Promise.all([
    chrome.tabs.query({ currentWindow: true }),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]);
  const activeId = active[0]?.id;
  const { decideRun: previousRun } = await chrome.storage.local.get("decideRun");
  const previousSelection = new Set(Array.isArray(previousRun?.selectedTabIds) ? previousRun.selectedTabIds : []);
  visibleTabs = tabs.filter(tab => {
    const url = tab.url || "";
    const isOllamaHelper = /^http:\/\/(?:127\.0\.0\.1|localhost):11434(?:\/|$)/i.test(url);
    return Number.isInteger(tab.id) && /^https?:\/\//i.test(url) && !isOllamaHelper;
  });
  ui.tabList.replaceChildren();
  if (!visibleTabs.length) {
    ui.tabList.append(makeEmpty("Open the pages you want to use, then come back here."));
    updateCount();
    return;
  }
  const savedSelection = previousSelection.size
    ? new Set(visibleTabs.filter(tab => previousSelection.has(tab.id)).map(tab => tab.id))
    : new Set(visibleTabs.filter(tab => tab.id === activeId).map(tab => tab.id));
  visibleTabs.forEach(tab => {
    const label = document.createElement("label");
    label.className = "tab-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "decide-tab";
    checkbox.value = String(tab.id);
    checkbox.checked = savedSelection.has(tab.id);
    checkbox.addEventListener("change", () => {
      const checked = getSelectedTabIds();
      if (checked.length > 8) {
        checkbox.checked = false;
        showError("Choose up to eight pages for one decision.");
      }
      updateCount();
    });
    const icon = document.createElement("span");
    icon.className = "favicon";
    if (tab.favIconUrl && /^https?:\/\//i.test(tab.favIconUrl)) {
      const image = document.createElement("img");
      image.alt = "";
      image.src = tab.favIconUrl;
      image.addEventListener("error", () => { icon.textContent = safeHost(tab.url).slice(0, 1).toUpperCase(); }, { once: true });
      icon.append(image);
    } else icon.textContent = safeHost(tab.url).slice(0, 1).toUpperCase();
    const copy = document.createElement("span");
    copy.className = "tab-copy";
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || safeHost(tab.url);
    const url = document.createElement("span");
    url.className = "tab-url";
    url.textContent = safeHost(tab.url);
    copy.append(title, url);
    label.append(checkbox, icon, copy);
    ui.tabList.append(label);
  });
  updateCount();
}

function makeEmpty(text) {
  const box = document.createElement("div");
  box.className = "empty-state";
  box.textContent = text;
  return box;
}

function getSelectedTabIds() {
  return Array.from(ui.tabList.querySelectorAll('input[name="decide-tab"]:checked')).map(input => Number(input.value));
}

function updateCount() {
  const count = getSelectedTabIds().length;
  ui.selectedCount.textContent = `${count} selected`;

  // Describe the tabs visible in this window rather than implying eight are open.
  // Chrome tabs in another window are not included because loadTabs uses currentWindow.
  const limitNote = ui.tabList.parentElement?.querySelector(".selection-footer span:last-child");
  if (limitNote) {
    const maximum = Math.min(8, visibleTabs.length);
    limitNote.textContent = maximum >= 2 ? `Choose 2 to ${maximum} pages` : "Open at least 2 pages";
  }
}

function showError(message, title = "Something needs your attention") {
  ui.error.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = title;
  const messageNode = document.createElement("span");
  messageNode.textContent = message;
  ui.error.append(strong, messageNode);
  ui.error.classList.remove("hidden");
}

function clearError() {
  ui.error.replaceChildren();
  ui.error.classList.add("hidden");
}

async function makeDecision() {
  clearError();
  ui.result.replaceChildren();
  ui.result.classList.add("hidden");
  const goal = ui.goal.value.trim();
  const tabIds = getSelectedTabIds();
  if (!goal) return showError("Write the decision you need to make first.", "Add your goal");
  if (tabIds.length < 2) return showError("Choose at least two pages with options you are considering.", "Choose more pages");
  if (tabIds.length > 8) return showError("Choose no more than eight pages for one decision.", "Too many pages");
  ui.make.disabled = true;
  ui.progress.classList.remove("hidden");
  ui.cancel.classList.remove("hidden");
  ui.progressTitle.textContent = "Getting your decision ready";
  ui.progressText.textContent = "Reading the pages you selected.";
  const response = await chrome.runtime.sendMessage({ type: "DECIDE_START", goal, tabIds });
  if (!response?.ok) {
    ui.make.disabled = false;
    ui.progress.classList.add("hidden");
    ui.cancel.classList.add("hidden");
    showError(response?.error || "Decide could not start. Please try again.");
    return;
  }
  const { decideRun } = await chrome.storage.local.get("decideRun");
  renderRun(decideRun);
}

async function cancelDecision() {
  ui.cancel.disabled = true;
  await chrome.runtime.sendMessage({ type: "DECIDE_CANCEL" });
  ui.cancel.disabled = false;
  const { decideRun } = await chrome.storage.local.get("decideRun");
  renderRun(decideRun);
}

function renderRun(run) {
  if (!run) return;
  runState = run;
  const isRunning = run.status === "running";
  ui.make.disabled = isRunning;
  ui.cancel.classList.toggle("hidden", !isRunning);
  ui.cancel.disabled = false;
  ui.progress.classList.toggle("hidden", !isRunning);
  ui.error.classList.add("hidden");
  if (isRunning) {
    ui.progressTitle.textContent = "Working on your decision";
    ui.progressText.textContent = run.stage || "Finding the facts that matter.";
    if (run.progress?.total) ui.progressText.textContent += ` (${run.progress.current || 0} of ${run.progress.total} pages)`;
  }
  if (run.status === "error") {
    showError(run.error || "Decide could not finish. Check that Ollama is open and signed in.", "Your decision could not be completed");
  }
  if (run.status === "cancelled") {
    showError("This run was cancelled. You can change your selections and try again.", "Decision cancelled");
  }
  if (run.status === "completed" && run.result) renderResult(run);
}

function appendList(parent, titleText, values) {
  if (!Array.isArray(values) || !values.length) return;
  const section = document.createElement("section");
  section.className = "result-card";
  const heading = document.createElement("h3");
  heading.textContent = titleText;
  const list = document.createElement("ul");
  list.className = titleText === "Trade offs" ? "tradeoff-list" : "caveat-list";
  values.forEach(value => {
    const item = document.createElement("li");
    item.textContent = value;
    list.append(item);
  });
  section.append(heading, list);
  parent.append(section);
}

function factDisplay(fact) {
  const value = String(fact?.value || "").trim();
  const unit = String(fact?.unit || "").trim();
  if (!value) return value;
  const isCurrentPrice = /^(?:current listed price|discounted price|sale price|offer price|price \(discounted\))$/i.test(String(fact?.attribute || "").trim());
  const priceContext = `${value} ${unit} ${String(fact?.evidence || "")}`;
  if (isCurrentPrice && /(?:₹|\bINR\b|\bRs\.?\b)/i.test(priceContext)) {
    const amountText = value.replace(/^\s*(?:₹|Rs\.?|INR)\s*/i, "").replace(/\s*(?:₹|Rs\.?|INR)\s*$/i, "").trim();
    if (/^\d[\d,]*(?:\.\d{1,2})?$/.test(amountText)) {
      const amount = Number(amountText.replace(/,/g, ""));
      if (Number.isFinite(amount) && amount > 0) {
        return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
      }
    }
  }
  if (!unit) return value;
  const normalizedValue = value.toLowerCase().replace(/\s+/g, "");
  const normalizedUnit = unit.toLowerCase().replace(/\s+/g, "");
  if (normalizedValue.includes(normalizedUnit)) return value;
  if (["inr", "usd", "eur", "gbp"].includes(normalizedUnit) && /[₹$€£]/.test(value)) return value;
  return `${value} ${unit}`;
}

function renderResult(run) {
  ui.result.replaceChildren();
  ui.result.classList.remove("hidden");
  const result = run.result;
  const recommended = result.status === "recommendation"
    ? (run.extractedItems || []).find(item => item.id === result.recommendedItemId)
    : null;
  const hero = document.createElement("section");
  hero.className = "result-hero";
  const kicker = document.createElement("div");
  kicker.className = "result-kicker";
  kicker.textContent = result.status === "recommendation" ? "DECISION READY" : result.status === "insufficient_evidence" ? "MORE EVIDENCE NEEDED" : "TRADE-OFFS TO CONSIDER";
  const title = document.createElement("h2");
  title.className = "result-title";
  title.textContent = result.title || "Your decision";
  const reason = document.createElement("p");
  reason.className = "result-reason";
  reason.textContent = result.reason || "The available information has been reviewed.";
  hero.append(kicker, title, reason);
  if (recommended) {
    const link = document.createElement("a");
    link.href = recommended.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "provider-tag";
    link.textContent = `Recommended: ${recommended.title}`;
    hero.append(link);
  }
  if (run.provider) {
    const provider = document.createElement("div");
    provider.className = "provider-tag";
    provider.textContent = `AI used: ${run.provider}`;
    hero.append(provider);
  }
  ui.result.append(hero);

  if (Array.isArray(result.criteria) && result.criteria.length) {
    const card = document.createElement("section");
    card.className = "result-card";
    const heading = document.createElement("h3");
    heading.textContent = "What mattered in this decision";
    const chips = document.createElement("div");
    chips.className = "chips";
    result.criteria.forEach(text => {
      const chip = document.createElement("span"); chip.className = "chip"; chip.textContent = text; chips.append(chip);
    });
    card.append(heading, chips);
    ui.result.append(card);
  }

  const candidateCard = document.createElement("section");
  candidateCard.className = "result-card";
  const candidateHeading = document.createElement("h3");
  candidateHeading.textContent = "What the evidence says";
  candidateCard.append(candidateHeading);
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const itemMap = new Map((run.extractedItems || []).map(item => [item.id, item]));
  candidates.forEach((candidate, index) => {
    const row = document.createElement("div");
    row.className = "candidate";
    const head = document.createElement("div");
    head.className = "candidate-head";
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(index + 1);
    const name = document.createElement("span");
    name.className = "candidate-title";
    name.textContent = candidate.title || itemMap.get(candidate.itemId)?.title || "Selected page";
    head.append(rank, name);
    const assessment = document.createElement("p");
    assessment.className = "candidate-assessment";
    assessment.textContent = candidate.assessment || "There was not enough detail to explain this option fully.";
    row.append(head, assessment);
    const chips = document.createElement("div");
    chips.className = "chips";
    const item = itemMap.get(candidate.itemId);
    const factMap = new Map((item?.facts || []).map(fact => [fact.factId, fact]));
    (candidate.supportingFactIds || []).forEach(id => {
      const fact = factMap.get(id);
      if (!fact) return;
      const chip = document.createElement("span");
      chip.className = "chip";
      const strong = document.createElement("strong");
      strong.textContent = `${fact.attribute}: `;
      chip.append(strong, document.createTextNode(factDisplay(fact)));
      chip.title = fact.evidence || "Source evidence";
      chips.append(chip);
    });
    if (chips.childElementCount) row.append(chips);
    const prosCons = [...(candidate.pros || []).map(value => `Strength: ${value}`), ...(candidate.cons || []).map(value => `Concern: ${value}`)];
    if (prosCons.length) {
      const detail = document.createElement("ul"); detail.className = "tradeoff-list";
      prosCons.slice(0, 8).forEach(value => { const li = document.createElement("li"); li.textContent = value; detail.append(li); });
      row.append(detail);
    }
    if (item?.url) {
      const source = document.createElement("p"); source.className = "source-note";
      const anchor = document.createElement("a"); anchor.href = item.url; anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; anchor.textContent = "Open source page";
      source.append(anchor); row.append(source);
    }
    candidateCard.append(row);
  });
  ui.result.append(candidateCard);
  appendList(ui.result, "Trade offs", result.tradeoffs);
  appendList(ui.result, "Still unknown", result.missingInformation);
  appendList(ui.result, "Things to keep in mind", result.caveats);
  if (result.nextStep) {
    const next = document.createElement("section"); next.className = "result-card";
    const heading = document.createElement("h3"); heading.textContent = "Before you decide";
    const text = document.createElement("p"); text.className = "result-reason"; text.textContent = result.nextStep;
    next.append(heading, text); ui.result.append(next);
  }
  if (Array.isArray(run.errors) && run.errors.length) {
    const notes = document.createElement("section"); notes.className = "result-card";
    const heading = document.createElement("h3"); heading.textContent = "Notes from this run";
    const text = document.createElement("p"); text.className = "result-reason"; text.textContent = run.errors.slice(0, 3).join(" ");
    notes.append(heading, text); ui.result.append(notes);
  }
}

async function loadSettings() {
  const { decideSettings } = await chrome.storage.local.get("decideSettings");
  const settings = { ...DEFAULT_SETTINGS, ...(decideSettings || {}) };
  $("geminiKey").value = settings.geminiApiKey || "";
  $("groqKey").value = settings.groqApiKey || "";
  $("openRouterKey").value = settings.openRouterApiKey || "";
  $("ollamaModel").value = settings.ollamaModel || DEFAULT_SETTINGS.ollamaModel;
  $("geminiModel").value = settings.geminiModel || DEFAULT_SETTINGS.geminiModel;
  $("groqModel").value = settings.groqModel || DEFAULT_SETTINGS.groqModel;
  $("openRouterModel").value = settings.openRouterModel || DEFAULT_SETTINGS.openRouterModel;
}

async function saveSettings() {
  const settings = {
    geminiApiKey: $("geminiKey").value.trim(),
    groqApiKey: $("groqKey").value.trim(),
    openRouterApiKey: $("openRouterKey").value.trim(),
    ollamaModel: $("ollamaModel").value.trim() || DEFAULT_SETTINGS.ollamaModel,
    geminiModel: $("geminiModel").value.trim() || DEFAULT_SETTINGS.geminiModel,
    groqModel: $("groqModel").value.trim() || DEFAULT_SETTINGS.groqModel,
    openRouterModel: $("openRouterModel").value.trim() || DEFAULT_SETTINGS.openRouterModel
  };
  await chrome.storage.local.set({ decideSettings: settings });
  ui.settingsStatus.textContent = "Saved on this device.";
  setTimeout(() => { ui.settingsStatus.textContent = ""; }, 2600);
}

$("refreshTabs").addEventListener("click", () => { clearError(); void loadTabs(); });
ui.make.addEventListener("click", () => { void makeDecision(); });
ui.cancel.addEventListener("click", () => { void cancelDecision(); });
$("settingsToggle").addEventListener("click", async () => {
  await loadSettings(); ui.settings.classList.toggle("hidden");
});
$("settingsClose").addEventListener("click", () => ui.settings.classList.add("hidden"));
$("saveSettings").addEventListener("click", () => { void saveSettings(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.decideRun?.newValue) renderRun(changes.decideRun.newValue);
});

(async () => {
  await loadTabs();
  await loadSettings();
  const { decideRun } = await chrome.storage.local.get("decideRun");
  if (decideRun?.goal) ui.goal.value = decideRun.goal;
  if (decideRun) renderRun(decideRun);
})();
