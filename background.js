"use strict";

const OFFSCREEN_PATH = "worker.html";
let creatingOffscreen = null;

const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
let ollamaHelperTabId = null;
let creatingOllamaHelperTab = null;
const ollamaRequestTabs = new Map();

async function waitForTabComplete(tabId, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("Decide could not open Ollama. Check that Ollama is running.");
    if (tab.status === "complete") return tab;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error("Ollama did not respond in time. Check that Ollama is running.");
}

async function ensureOllamaHelperTab() {
  if (ollamaHelperTabId !== null) {
    const current = await chrome.tabs.get(ollamaHelperTabId).catch(() => null);
    if (current && (current.url || "").startsWith(OLLAMA_ORIGIN)) return current.id;
    ollamaHelperTabId = null;
  }
  const saved = await chrome.storage.session.get("decideOllamaHelperTabId").catch(() => ({}));
  if (Number.isInteger(saved.decideOllamaHelperTabId)) {
    const current = await chrome.tabs.get(saved.decideOllamaHelperTabId).catch(() => null);
    if (current && (current.url || "").startsWith(OLLAMA_ORIGIN)) {
      ollamaHelperTabId = current.id;
      return current.id;
    }
  }
  if (!creatingOllamaHelperTab) {
    creatingOllamaHelperTab = (async () => {
      const tab = await chrome.tabs.create({ url: `${OLLAMA_ORIGIN}/`, active: false });
      if (!Number.isInteger(tab.id)) throw new Error("Decide could not open the local Ollama connection.");
      ollamaHelperTabId = tab.id;
      await chrome.storage.session.set({ decideOllamaHelperTabId: tab.id }).catch(() => {});
      const loaded = await waitForTabComplete(tab.id);
      if (!(loaded.url || "").startsWith(OLLAMA_ORIGIN)) {
        throw new Error("Ollama did not open on its local address. Check that Ollama is running.");
      }
      return tab.id;
    })().finally(() => { creatingOllamaHelperTab = null; });
  }
  return creatingOllamaHelperTab;
}

async function handleOllamaRequest(message, sendResponse) {
  let tabId = null;
  try {
    tabId = await ensureOllamaHelperTab();
    ollamaRequestTabs.set(message.requestId, tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [{ requestId: message.requestId, path: message.path, options: message.options || {} }],
      func: async payload => {
        const url = new URL(payload.path, location.origin);
        if (url.origin !== location.origin) return { ok: false, status: 0, text: "Ollama request was not local." };
        const registry = globalThis.__decideOllamaControllers || (globalThis.__decideOllamaControllers = Object.create(null));
        const controller = new AbortController();
        registry[payload.requestId] = controller;
        try {
          const response = await fetch(url.href, { ...payload.options, signal: controller.signal });
          return { ok: response.ok, status: response.status, text: await response.text() };
        } catch (error) {
          return { ok: false, status: 0, text: error instanceof Error ? error.message : String(error), name: error?.name || "Error" };
        } finally {
          delete registry[payload.requestId];
        }
      }
    });
    const result = results?.[0]?.result;
    if (!result || typeof result.status !== "number") throw new Error("Ollama returned an unreadable response.");
    sendResponse({ ok: true, response: result });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    ollamaRequestTabs.delete(message.requestId);
  }
}

async function cancelOllamaRequest(requestId) {
  const tabId = ollamaRequestTabs.get(requestId) ?? ollamaHelperTabId;
  if (!Number.isInteger(tabId)) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [requestId],
    func: id => {
      globalThis.__decideOllamaControllers?.[id]?.abort();
      return true;
    }
  }).catch(() => {});
}

async function releaseOllamaHelperTab() {
  const saved = await chrome.storage.session.get("decideOllamaHelperTabId").catch(() => ({}));
  const tabId = ollamaHelperTabId ?? saved.decideOllamaHelperTabId;
  ollamaHelperTabId = null;
  await chrome.storage.session.remove("decideOllamaHelperTabId").catch(() => {});
  if (Number.isInteger(tabId)) await chrome.tabs.remove(tabId).catch(() => {});
}

chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === ollamaHelperTabId) {
    ollamaHelperTabId = null;
    void chrome.storage.session.remove("decideOllamaHelperTabId").catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] }).catch(() => []);
    if (contexts.length) return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["DOM_PARSER"],
      justification: "Keep a decision run working if the Decide panel is closed, and handle structured model responses safely."
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function setRun(run) {
  await chrome.storage.local.set({ decideRun: run });
}

async function captureTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error(`“${tab.title || "This tab"}” is a browser page that Decide cannot read. Choose a regular website instead.`);
  }
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const collapse = value => String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      const text = collapse(document.body?.innerText || "");
      const description = document.querySelector('meta[name="description"]')?.content || "";
      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .map(node => collapse(node.innerText)).filter(Boolean).slice(0, 45);
      const structuredData = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .slice(0, 4).map(node => collapse(node.textContent)).filter(Boolean).map(value => value.slice(0, 3000));
      return {
        title: document.title || location.hostname,
        url: location.href,
        description: collapse(description).slice(0, 700),
        headings,
        structuredData,
        visibleText: text.slice(0, 16000)
      };
    }
  });
  const page = result?.[0]?.result;
  if (!page || page.visibleText.length < 30) {
    throw new Error(`Decide could not read enough visible information from “${tab.title || "this tab"}”.`);
  }
  return {
    id: `tab_${tabId}`,
    tabId,
    title: page.title || tab.title || "Untitled page",
    url: page.url || tab.url,
    favicon: tab.favIconUrl || "",
    description: page.description || "",
    headings: page.headings || [],
    structuredData: page.structuredData || [],
    visibleText: page.visibleText || ""
  };
}

async function beginDecision(message, sendResponse) {
  const goal = typeof message.goal === "string" ? message.goal.trim().slice(0, 1000) : "";
  const tabIds = Array.isArray(message.tabIds) ? [...new Set(message.tabIds.filter(Number.isInteger))].slice(0, 8) : [];
  if (!goal) { sendResponse({ ok: false, error: "Write the decision you need to make first." }); return; }
  if (tabIds.length < 2) { sendResponse({ ok: false, error: "Choose at least two pages so Decide has options to work with." }); return; }

  const runId = crypto.randomUUID();
  const initial = {
    runId,
    selectedTabIds: tabIds,
    status: "running",
    stage: "Reading the pages you selected…",
    progress: { current: 0, total: tabIds.length },
    goal,
    startedAt: Date.now(),
    result: null,
    pages: [],
    errors: [],
    provider: ""
  };
  await setRun(initial);
  sendResponse({ ok: true, runId });

  void (async () => {
    const errors = [];
    const pages = [];
    try {
      for (let i = 0; i < tabIds.length; i++) {
        const current = await chrome.storage.local.get("decideRun");
        if (current.decideRun?.runId !== runId || current.decideRun?.status === "cancelled") return;
        await setRun({ ...current.decideRun, stage: `Reading page ${i + 1} of ${tabIds.length}…`, progress: { current: i, total: tabIds.length } });
        try { pages.push(await captureTab(tabIds[i])); }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      }
      if (pages.length < 2) throw new Error(`Decide could only read ${pages.length} selected pages. Choose regular website tabs and check that they have finished loading. ${errors.join(" ")}`);
      await ensureOffscreen();
      const { decideSettings = {} } = await chrome.storage.local.get("decideSettings");
      const response = await chrome.runtime.sendMessage({ type: "DECIDE_PROCESS", runId, goal, pages, captureErrors: errors, settings: decideSettings });
      if (response?.ok === false) throw new Error(response.error || "Could not start the decision worker.");
    } catch (error) {
      const current = await chrome.storage.local.get("decideRun");
      if (current.decideRun?.runId === runId && current.decideRun?.status !== "cancelled") {
        await setRun({ ...current.decideRun, status: "error", stage: "Decide could not finish this run.", error: error instanceof Error ? error.message : String(error), errors });
      }
    }
  })();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "DECIDE_OLLAMA_REQUEST") {
    void handleOllamaRequest(message, sendResponse);
    return true;
  }
  if (message?.type === "DECIDE_OLLAMA_CANCEL") {
    void cancelOllamaRequest(message.requestId).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "DECIDE_OLLAMA_RELEASE") {
    void releaseOllamaHelperTab().then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "DECIDE_START") {
    void beginDecision(message, sendResponse);
    return true;
  }
  if (message?.type === "DECIDE_CANCEL") {
    void (async () => {
      const { decideRun } = await chrome.storage.local.get("decideRun");
      if (decideRun?.status === "running") await setRun({ ...decideRun, status: "cancelled", stage: "Decision cancelled.", result: null });
      chrome.runtime.sendMessage({ type: "DECIDE_WORKER_CANCEL", runId: decideRun?.runId }).catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === "DECIDE_WORKER_UPDATE") {
    void (async () => {
      const { decideRun } = await chrome.storage.local.get("decideRun");
      if (!decideRun || decideRun.runId !== message.runId || decideRun.status === "cancelled") {
        sendResponse({ ok: false, reason: "run no longer active" });
        return;
      }
      await setRun({ ...decideRun, ...(message.patch || {}), runId: message.runId });
      sendResponse({ ok: true });
    })().catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "DECIDE_PROCESS") return false;
  return false;
});
