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

async function captureTab(tabId, decisionGoal = "") {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error(`“${tab.title || "This tab"}” is a browser page that Decide cannot read. Choose a regular website instead.`);
  }
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    args: [decisionGoal],
    func: async decisionGoal => {
      const collapse = value => String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      // Retailer pages can report document.complete before variant prices and detail
      // panels finish hydrating. Sample readable-text stability before collecting facts.
      const waitForReadableStability = async (maxMs = 2200, minRetailerStableMs = 900) => {
        const startedAt = Date.now();
        const deadline = startedAt + maxMs;
        const hostname = String(location?.hostname || "");
        const trackAmazonProduct = /(^|\.)amazon\./i.test(hostname) && Boolean(document.querySelector("#productTitle"));
        const trackFlipkartProduct = /(^|\.)flipkart\.com$/i.test(hostname) && Boolean(document.querySelector("h1"));
        const trackRetailerPrice = trackAmazonProduct || trackFlipkartProduct;
        const priceSelectors = trackAmazonProduct ? [
          "#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen",
          "#corePriceDisplay_desktop_feature_div [aria-label*='₹'], #corePriceDisplay_desktop_feature_div [aria-label*='Rs']",
          "#corePriceDisplay_mobile_feature_div .priceToPay .a-offscreen",
          "#corePriceDisplay_mobile_feature_div [aria-label*='₹'], #corePriceDisplay_mobile_feature_div [aria-label*='Rs']",
          "#corePrice_feature_div .priceToPay .a-offscreen",
          "#corePrice_feature_div [aria-label*='₹'], #corePrice_feature_div [aria-label*='Rs']",
          "#apex_desktop .priceToPay .a-offscreen",
          "#apex_desktop [aria-label*='₹'], #apex_desktop [aria-label*='Rs']",
          "#desktop_buybox .priceToPay .a-offscreen",
          "#desktop_buybox [aria-label*='₹'], #desktop_buybox [aria-label*='Rs']",
          "#buybox_feature_div .priceToPay .a-offscreen",
          "#buybox_feature_div [aria-label*='₹'], #buybox_feature_div [aria-label*='Rs']",
          "#price .priceToPay .a-offscreen",
          "#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen",
          "#corePriceDisplay_mobile_feature_div .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen",
          "#corePrice_feature_div .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen",
          "#apex_desktop .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen",
          "#desktop_buybox .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen",
          "#buybox_feature_div .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen",
          "#price .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen",
          "#priceblock_dealprice", "#priceblock_ourprice", "#price_inside_buybox",
          "#price [aria-label*='₹'], #price [aria-label*='Rs']"
        ] : trackFlipkartProduct ? ["[class*='Nx9bqj']", "[class*='_30jeq3']"] : [];
        const retailerPriceSignature = () => {
          if (!trackRetailerPrice) return "";
          const values = [];
          for (const selector of priceSelectors) {
            try {
              for (const node of Array.from(document.querySelectorAll(selector)).slice(0, 12)) {
                if (!node?.getClientRects?.().length || node.closest?.('[hidden], [aria-hidden="true"]')) continue;
                const priceContainer = node.closest?.('.a-price, .priceToPay, .apexPriceToPay');
                const value = collapse(node.innerText || node.textContent || node.getAttribute?.("aria-label") || priceContainer?.getAttribute?.("aria-label") || "");
                if (value) values.push(value);
              }
            } catch { /* a changed retailer selector must not break page capture */ }
          }
          return [...new Set(values)].join(" | ");
        };
        let previousLength = -1;
        let previousPriceSignature = null;
        let stableSamples = 0;
        while (Date.now() < deadline) {
          const readableLength = collapse(document.body?.innerText || "").length;
          const priceSignature = retailerPriceSignature();
          const ready = !document.readyState || document.readyState === "complete" || document.readyState === "interactive";
          if (ready && readableLength >= 40) {
            if (previousLength >= 0) {
              const allowedChange = Math.max(30, previousLength * 0.03);
              const textStable = Math.abs(readableLength - previousLength) <= allowedChange;
              const priceStable = !trackRetailerPrice || (Boolean(priceSignature) && priceSignature === previousPriceSignature);
              stableSamples = textStable && priceStable ? stableSamples + 1 : 0;
              // Retailer pages can hydrate the selected price after the rest of the page
              // text has stopped growing. Require a stable, non-empty product-price signal
              // and a short minimum settling window before the initial capture proceeds.
              if (stableSamples >= 2 && (!trackRetailerPrice || Date.now() - startedAt >= minRetailerStableMs)) return true;
            }
            previousLength = readableLength;
            previousPriceSignature = priceSignature;
          } else {
            previousLength = -1;
            previousPriceSignature = null;
            stableSamples = 0;
          }
          await new Promise(resolve => setTimeout(resolve, 180));
        }
        return false;
      };
      await waitForReadableStability();
      const title = document.title || location.hostname;
      const description = document.querySelector('meta[name="description"]')?.content || "";

      // Match the private reference's bounded disclosure recovery: open only controls
      // that plausibly reveal specifications/details, never purchase, account, navigation,
      // review or recommendation controls. This matters on stores that populate display
      // specifications only after their product-details accordion is expanded.
      const originalScrollX = window.scrollX || 0;
      const originalScrollY = window.scrollY || 0;
      const disclosureRoot = document.body || document.querySelector('#centerCol, main, article, [role="main"]');
      const disclosureForbidden = /(?:buy now|add to cart|add to bag|checkout|place order|purchase|payment|emi|finance|wishlist|share|location|address|pincode|delivery|shipping|seller|reviews?|questions?|answers?|related products?|similar items?|recommended|recommendations?|frequently bought|customers also|sponsored|advertis|offers?|coupons?|subscribe|sign in|login|account|menu|navigation|compare)/i;
      const disclosureLabels = /^(?:specifications?|view all specifications|view more specifications|view all specs|see all specifications|show all specifications|product specifications|technical details|product details|additional details|display|display specifications|view full details|view more details|show more details|view more|show more|see more|more details|view specifications|view all|read more|read full specifications|read more specifications)$/i;
      const isDisclosureNoise = node => {
        let current = node;
        for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
          const marker = `${String(current.id || '')} ${String(current.className?.baseVal || current.className || '')} ${current.getAttribute?.('aria-label') || ''} ${current.querySelector?.('h1,h2,h3,h4')?.textContent || ''}`;
          if (disclosureForbidden.test(marker)) return true;
          if (current.matches?.('nav, header, footer, aside, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"]')) return true;
        }
        return false;
      };
      const disclosureTargets = control => {
        const targets = [];
        const seen = new Set();
        const add = target => { if (target && target !== control && !seen.has(target)) { seen.add(target); targets.push(target); } };
        const ids = String(control.getAttribute?.('aria-controls') || '').split(/\s+/).filter(Boolean);
        for (const id of ids) add(document.getElementById(id));
        let current = control;
        for (let depth = 0; current && depth < 3; depth += 1, current = current.parentElement) {
          add(current.nextElementSibling);
          if (current.parentElement) Array.from(current.parentElement.children).slice(0, 10).forEach(add);
        }
        return targets;
      };
      const targetIsCollapsed = target => {
        if (!target || !(target instanceof HTMLElement)) return false;
        if (target.hidden || target.getAttribute('aria-hidden') === 'true') return true;
        const style = window.getComputedStyle(target);
        if (style.display === 'none' || style.visibility === 'hidden') return true;
        const clipped = /^(?:hidden|clip)$/.test(style.overflowY || style.overflow || '') || /^(?:hidden|clip)$/.test(style.overflow || '');
        return clipped && target.scrollHeight > target.clientHeight + 4;
      };
      const expandProductSpecifications = async () => {
        let expanded = 0;
        for (const detail of Array.from(disclosureRoot.querySelectorAll?.('details:not([open])') || []).slice(0, 20)) {
          const label = collapse(detail.querySelector('summary')?.innerText || detail.textContent).slice(0, 120);
          if (!disclosureLabels.test(label) && !/specification|product details|technical details|display|screen/i.test(label)) continue;
          if (isDisclosureNoise(detail)) continue;
          detail.setAttribute('open', '');
          expanded += 1;
        }
        const controls = Array.from(disclosureRoot.querySelectorAll?.('button, [role="button"], [aria-expanded="false"], [aria-controls], [onclick]') || []);
        for (const control of controls) {
          if (expanded >= 18) break;
          if (control.matches?.(':disabled, [aria-disabled="true"]') || isDisclosureNoise(control)) continue;
          const tag = control.tagName?.toLowerCase();
          if (tag === 'a' || control.getAttribute?.('href') || control.getAttribute?.('formaction') || control.getAttribute?.('type')?.toLowerCase() === 'submit' || control.closest?.('form')) continue;
          const label = collapse(control.innerText || control.textContent || control.getAttribute?.('aria-label') || control.getAttribute?.('title') || '').slice(0, 120);
          if (!disclosureLabels.test(label)) continue;
          const targets = disclosureTargets(control);
          const explicitCollapsedTarget = control.getAttribute?.('aria-expanded') === 'false' && targets.length > 0;
          const explicitSpecificationDisclosure = /^(?:specifications?|view all specifications|view more specifications|view all specs|see all specifications|show all specifications|product specifications|technical details|product details|additional details|display|display specifications|view full details|read full specifications)$/i.test(label) && Boolean(control.getAttribute?.('aria-controls')) && targets.length > 0;
          if (!explicitCollapsedTarget && !explicitSpecificationDisclosure && !targets.some(targetIsCollapsed)) continue;
          try {
            control.click();
            expanded += 1;
            await new Promise(resolve => setTimeout(resolve, 80));
          } catch { /* best-effort content expansion; extraction continues */ }
        }
        try { window.scrollTo(originalScrollX, originalScrollY); } catch {}
      };
      await expandProductSpecifications();
      await waitForReadableStability(1200, 360);
      const allText = collapse(document.body?.innerText || "");
      const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
        .map(node => collapse(node.innerText || node.textContent)).filter(Boolean).slice(0, 45);
      const structuredData = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .slice(0, 8).map(node => collapse(node.textContent)).filter(Boolean).map(value => value.slice(0, 4000));

      // Preserve explicit label/value facts from product tables and structured markup.
      // The earlier private build did this before calling the model; the public capture
      // had reduced most of those details to text excerpts, which could omit specifications
      // near the bottom of a marketplace page.
      const factSignals = [];
      const factSignalKeys = new Set();
      const factLabelPattern = /(?:display|screen|resolution|refresh rate|brightness|panel|ppi|pixel density|touchscreen|aspect ratio|battery|camera|ram|memory|storage|processor|chipset|operating system|android|os upgrade|security update|warranty|weight|dimensions|connectivity|nfc|esim|fingerprint|water resistance|dust resistance|ip rating|charging|material|model|brand|price|mrp|rating|speaker|audio|sensor|network|sim type|wi[ -]?fi|bluetooth|capacity|protection|features?)/i;
      const cleanSignal = value => collapse(String(value || '').replace(/^[•*–—-]+/, '')).slice(0, 500);
      const normalizeSpecLabel = value => cleanSignal(value).replace(/\s*\([^()]*\)\s*$/, '').replace(/[：:]\s*$/, '').trim();
      const addFactSignal = (attribute, value, source, evidence) => {
        const cleanAttribute = cleanSignal(attribute).slice(0, 80);
        const cleanValue = cleanSignal(value);
        const cleanEvidence = cleanSignal(evidence || `${cleanAttribute}: ${cleanValue}`);
        if (!cleanAttribute || !cleanValue || !cleanEvidence || cleanAttribute.length < 2) return;
        if (!factLabelPattern.test(cleanAttribute)) return;
        if (/^https?:\/\//i.test(cleanValue) || /^https?:\/\//i.test(cleanEvidence)) return;
        const key = `${cleanAttribute.toLowerCase()}::${cleanValue.toLowerCase()}`;
        if (factSignalKeys.has(key)) return;
        factSignalKeys.add(key);
        factSignals.push({ attribute: cleanAttribute, value: cleanValue, source, evidence: cleanEvidence });
      };
      const mainEvidenceRoot = document.querySelector('main, article, [role="main"]') || document.body;
      const isExcludedEvidenceNode = node => {
        let current = node;
        for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
          const id = String(current.id || '');
          const className = String(current.className?.baseVal || current.className || '');
          const markers = `${id} ${className} ${current.getAttribute?.('aria-label') || ''}`;
          if (/(?:sponsored|advert|recommend|related[-_ ]?product|similar[-_ ]?product|frequently[-_ ]?bought|recently[-_ ]?viewed|customer[-_ ]?also|carousel|search[-_ ]?result|review[-_ ]?list|question[-_ ]?list)/i.test(markers)) return true;
          if (current.matches?.('nav, header, footer, aside, [role="navigation"], [role="complementary"], [role="search"]')) return true;
        }
        return false;
      };
      const humanizeSignalLabel = value => String(value || '')
        .replace(/^.*[.#]/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ').trim().replace(/\b\w/g, char => char.toUpperCase());

      // Table and definition-list rows are reliable sources for properties such as
      // Display Type, Display Size, Resolution and Refresh Rate. Limit collection to the
      // main content, and discard ad/recommendation/review containers before making facts.
      const descendants = (root, selector) => {
        try { return Array.from(root?.querySelectorAll?.(selector) || []); } catch { return []; }
      };
      // Reserve capacity for screen/display details before generic hardware rows. Retailer
      // pages can expose hundreds of non-display facts before the display section.
      const displaySignalLabel = /^(?:display(?:\s+(?:type|size|resolution|features?|technology|panel|refresh\s+rate|specifications?))?|screen(?:\s+(?:type|size|resolution|features?|technology|specifications?))?|resolution|refresh\s+rate|peak\s+brightness|brightness|panel\s+type|pixel\s+density|ppi|aspect\s+ratio|screen\s+to\s+body\s+ratio)$/i;
      // Pre-pass adjacent DIV/SPAN label/value rows as used by retailer specification
      // apps. Do this before general page tables so a long details page cannot crowd
      // these display facts out of the signal budget.
      for (const labelNode of descendants(document, 'div, span, dt, th, td, li').slice(0, 24000)) {
        if (isExcludedEvidenceNode(labelNode)) continue;
        const label = cleanSignal(labelNode.innerText || labelNode.textContent);
        const matchLabel = normalizeSpecLabel(label);
        if (!matchLabel || label.length > 80 || !displaySignalLabel.test(matchLabel)) continue;
        let current = labelNode;
        let value = '';
        for (let depth = 0; current && depth < 4 && !value; depth += 1, current = current.parentElement) {
          const siblings = current.parentElement ? Array.from(current.parentElement.children || []) : [];
          const index = siblings.indexOf(current);
          for (const sibling of siblings.slice(index + 1, index + 4)) {
            const candidate = cleanSignal(sibling.innerText || sibling.textContent);
            if (candidate && candidate.toLowerCase() !== label.toLowerCase() && candidate.length <= 500 && !displaySignalLabel.test(normalizeSpecLabel(candidate))) {
              value = candidate;
              break;
            }
          }
        }
        if (value) addFactSignal(label, value, 'dom', `${label}: ${value}`);
      }
      for (const row of descendants(document, 'tr').slice(0, 1600)) {
        if (isExcludedEvidenceNode(row)) continue;
        const cells = Array.from(row.querySelectorAll('th, td')).map(cell => cleanSignal(cell.innerText || cell.textContent)).filter(Boolean);
        if (cells.length >= 2 && displaySignalLabel.test(cells[0])) {
          addFactSignal(cells[0], cells.slice(1).join(' | '), 'dom', cells.join(' | '));
        }
      }
      for (const term of descendants(document, 'dt').slice(0, 900)) {
        if (isExcludedEvidenceNode(term)) continue;
        const label = cleanSignal(term.innerText || term.textContent);
        const definition = term.nextElementSibling;
        if (displaySignalLabel.test(label) && definition?.tagName?.toLowerCase() === 'dd') {
          addFactSignal(label, definition.innerText || definition.textContent, 'dom', `${label}: ${definition.innerText || definition.textContent}`);
        }
      }
      const evidenceRoots = Array.from(new Set([
        document,
        mainEvidenceRoot,
        ...Array.from(document.querySelectorAll('[id*="specification" i], [class*="specification" i], [data-testid*="specification" i], [id*="productDetails" i], [class*="product-details" i]')).slice(0, 40)
      ].filter(Boolean)));
      for (const root of evidenceRoots) {
        for (const row of descendants(root, 'tr').slice(0, 700)) {
          if (isExcludedEvidenceNode(row)) continue;
          const cells = Array.from(row.querySelectorAll('th, td')).map(cell => cleanSignal(cell.innerText || cell.textContent)).filter(Boolean);
          if (cells.length >= 2 && cells[0].length <= 80) {
            addFactSignal(cells[0], cells.slice(1).join(' | '), 'dom', cells.join(' | '));
          }
          if (factSignals.length >= 600) break;
        }
        if (factSignals.length >= 600) break;
        for (const term of descendants(root, 'dt').slice(0, 500)) {
          if (isExcludedEvidenceNode(term)) continue;
          const definition = term.nextElementSibling;
          if (definition?.tagName?.toLowerCase() === 'dd') {
            addFactSignal(term.innerText || term.textContent, definition.innerText || definition.textContent, 'dom', `${term.innerText || term.textContent}: ${definition.innerText || definition.textContent}`);
          }
          if (factSignals.length >= 600) break;
        }
        if (factSignals.length >= 600) break;
      }

      // Some commerce pages use adjacent label/value DIVs instead of a semantic table.
      // Read only exact specification labels and a nearby sibling value, not whole cards.
      const exactSpecLabel = /^(?:display(?: type| size| resolution| features| technology| panel| refresh rate)?|screen(?: type| size| resolution| features| technology)?|resolution|refresh rate|peak brightness|brightness|panel type|pixel density|aspect ratio|screen to body ratio|ram|internal storage|storage|battery capacity|processor|chipset|operating system|android version|rear camera|front camera|primary camera|fast charging|weight|dimensions|water resistance|dust resistance|ip rating|nfc|esim|fingerprint sensor|sim type|wireless charging)$/i;
      const labelNodes = descendants(document, 'div, span, dt, th, td, li').slice(0, 16000);
      for (const labelNode of labelNodes) {
        if (factSignals.length >= 600) break;
        if (isExcludedEvidenceNode(labelNode)) continue;
        const label = cleanSignal(labelNode.innerText || labelNode.textContent);
        const matchLabel = normalizeSpecLabel(label);
        if (!matchLabel || label.length > 80 || !exactSpecLabel.test(matchLabel)) continue;
        let current = labelNode;
        let value = '';
        for (let depth = 0; current && depth < 3 && !value; depth += 1, current = current.parentElement) {
          const siblings = current.parentElement ? Array.from(current.parentElement.children) : [];
          const index = siblings.indexOf(current);
          for (const sibling of siblings.slice(index + 1, index + 3)) {
            const candidate = cleanSignal(sibling.innerText || sibling.textContent);
            if (candidate && candidate.toLowerCase() !== label.toLowerCase() && candidate.length <= 500 && !exactSpecLabel.test(candidate)) {
              value = candidate;
              break;
            }
          }
        }
        if (value) addFactSignal(label, value, 'dom', `${label}: ${value}`);
      }

      // Also retain schema.org / microdata attributes. JSON-LD is evidence supplied by
      // the page, not automatically authoritative for current price; price policy below
      // still requires the dedicated retailer-specific price section.
      for (const element of descendants(document, '[itemprop]').slice(0, 500)) {
        if (isExcludedEvidenceNode(element)) continue;
        const attribute = element.getAttribute('itemprop');
        const value = element.getAttribute('content') || element.getAttribute('value') || element.innerText || element.textContent;
        if (attribute && value) addFactSignal(humanizeSignalLabel(attribute), value, 'dom', `${attribute}: ${value}`);
      }
      const selectedEntityTitle = collapse(document.querySelector('#productTitle')?.innerText || document.querySelector('h1')?.innerText || title);
      const normalizeEntityName = value => collapse(String(value || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const jsonLdEntityMatches = name => {
        const selectedName = normalizeEntityName(selectedEntityTitle);
        const candidateName = normalizeEntityName(name);
        if (!selectedName || !candidateName) return false;
        if (selectedName.includes(candidateName) || candidateName.includes(selectedName)) return true;
        const brands = ['samsung', 'oppo', 'iqoo', 'vivo', 'oneplus', 'xiaomi', 'redmi', 'realme', 'motorola', 'poco', 'nothing', 'apple', 'google'];
        const selectedBrand = brands.find(brand => selectedName.includes(brand));
        if (!selectedBrand || !candidateName.includes(selectedBrand)) return false;
        const modelPart = text => {
          const match = text.match(new RegExp(`${selectedBrand}\\s+([a-z0-9]+(?:\\s+[a-z0-9]+){0,2})`, 'i'));
          return match ? match[1].trim() : '';
        };
        const selectedModel = modelPart(selectedName);
        return Boolean(selectedModel && candidateName.includes(`${selectedBrand} ${selectedModel}`));
      };
      const jsonLdVariantMatches = name => {
        const selectedName = normalizeEntityName(selectedEntityTitle);
        const candidateName = normalizeEntityName(name);
        if (!selectedName || !candidateName) return false;
        // A selected RAM/storage variant must match both capacities in the offer name.
        const capacities = selectedName.match(/\b(\d{1,2})\s*gb\b.*?\b(\d{2,4})\s*gb\b/);
        if (capacities) {
          const [, ramCapacity, storageCapacity] = capacities;
          if (!new RegExp(`\\b${ramCapacity}\\s*gb\\b`).test(candidateName) || !new RegExp(`\\b${storageCapacity}\\s*gb\\b`).test(candidateName)) return false;
        }
        // If the selected title names a color/finish, don't borrow the price from a different finish.
        const parenthesizedVariant = String(selectedEntityTitle.match(/\(([^)]{1,100})\)/)?.[1] || '');
        const leadingVariant = parenthesizedVariant.split(',')[0].trim();
        if (/^[a-z][a-z -]{2,30}$/i.test(leadingVariant) && /\b(?:black|white|blue|green|olive|silver|gold|grey|gray|pink|purple|orange|red|graphite|titan|mint|lavender|ice|starlight)\b/i.test(leadingVariant)) {
          const normalizedVariant = normalizeEntityName(leadingVariant);
          if (!candidateName.includes(normalizedVariant)) return false;
        }
        return true;
      };
      const jsonLdProductObjects = [];
      const jsonLdPriceProductObjects = [];
      const findProductObjects = (value, depth = 0) => {
        if (depth > 8 || !value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          for (const child of value.slice(0, 80)) findProductObjects(child, depth + 1);
          return;
        }
        const typeValue = value['@type'];
        const typeNames = (Array.isArray(typeValue) ? typeValue : [typeValue]).filter(Boolean).map(String);
        const isProductGroup = typeNames.some(type => /ProductGroup$/i.test(type));
        const isProductObject = typeNames.some(type => /(?:^|\/)Product(?:Group|Model)?$/i.test(type) || /^(?:Product|ProductGroup|IndividualProduct|MobilePhone)$/i.test(type));
        const isOfferBearingProduct = typeNames.some(type => /(?:^|\/)Product$/i.test(type) || /^(?:IndividualProduct|MobilePhone)$/i.test(type));
        const entityName = value.name || value.productName || value.model;
        if (isProductObject && entityName && jsonLdEntityMatches(entityName)) {
          // A ProductGroup with hasVariant often carries only a low/high price range. Traverse
          // the variants instead of treating the group-level amount as the selected product.
          if (isProductGroup && value.hasVariant) {
            findProductObjects(value.hasVariant, depth + 1);
            return;
          }
          jsonLdProductObjects.push(value);
          if (isOfferBearingProduct && jsonLdVariantMatches(entityName)) jsonLdPriceProductObjects.push(value);
          return;
        }
        for (const [key, child] of Object.entries(value)) {
          if (key === '@context') continue;
          findProductObjects(child, depth + 1);
          if (jsonLdProductObjects.length >= 12 && jsonLdPriceProductObjects.length >= 1) break;
        }
      };
      const collectJsonLdSignals = (value, path = [], depth = 0) => {
        if (depth > 8 || factSignals.length >= 600 || value == null) return;
        if (Array.isArray(value)) {
          for (const child of value.slice(0, 80)) collectJsonLdSignals(child, path, depth + 1);
          return;
        }
        if (typeof value !== 'object') {
          const key = path[path.length - 1] || '';
          if (key && !/^@|url|image|logo|sameas|id$/i.test(key) && factLabelPattern.test(humanizeSignalLabel(key))) {
            addFactSignal(humanizeSignalLabel(key), String(value), 'json-ld', `${path.join('.')}: ${String(value)}`);
          }
          return;
        }
        for (const [key, child] of Object.entries(value)) {
          if (key === '@context' || key.toLowerCase() === 'image' || key.toLowerCase() === 'url') continue;
          collectJsonLdSignals(child, [...path, key], depth + 1);
          if (factSignals.length >= 600) break;
        }
      };
      for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 8)) {
        try {
          const parsed = JSON.parse(script.textContent || '');
          findProductObjects(parsed);
          if (jsonLdProductObjects.length >= 12 && jsonLdPriceProductObjects.length >= 1) break;
        } catch { /* malformed structured data is ignored */ }
      }
      // Do not flatten unrelated Product objects from recommendations/ad markup into the
      // chosen page's deterministic fact set. Only JSON-LD Product nodes whose name matches
      // the selected page title contribute signals.
      for (const productObject of jsonLdProductObjects) {
        collectJsonLdSignals(productObject);
        if (factSignals.length >= 600) break;
      }

      // Capture product-specific sections before looking at the long page-wide text.
      // This prevents navigation, reviews and recommendations from consuming the text budget.
      const sectionGroups = [
        ["product title", "#productTitle", true],
        ["product features", "#feature-bullets, [data-feature-name='featurebullets']", true],
        ["product description", "#productDescription, [data-feature-name='productDescription']", true],
        ["product specifications", "#detailBullets_feature_div, #prodDetails, #technicalSpecifications_section_1, #productOverview_feature_div, [data-feature-name='productDetails']", true],
        // Product pricing is captured separately below with retailer-specific selectors.
        // Never sweep every price element on a retailer page into one authoritative block.
        ["main product content", "#centerCol, main, article, [role='main']", false]
      ];
      const primaryParts = [];
      const searchParts = [];
      const productParts = [];
      const seenParts = new Set();
      const seenProductParts = new Set();
      let primaryLength = 0;
      let searchLength = 0;
      let productLength = 0;

      // Amazon pages contain many unrelated amounts (recommendations, financing, coupons,
      // and alternate offers). Read the selected product's primary price only from its
      // dedicated core-price container; never make a page-wide a-price span authoritative.
      if (/(^|\.)amazon\./i.test(location.hostname)) {
        const visible = node => Boolean(node && node.getClientRects && node.getClientRects().length && !node.closest('[hidden], [aria-hidden="true"]'));
        const textOf = node => collapse(node?.innerText || node?.textContent || "");
        const accessiblePriceText = node => {
          const container = node?.closest?.('.a-price, .priceToPay, .apexPriceToPay');
          const labels = [node?.getAttribute?.('aria-label'), container?.getAttribute?.('aria-label')];
          for (const label of labels) {
            const normalized = collapse(label || '');
            const match = normalized.match(/^(?:(?:(?:current|sale|listed|our|deal)\s+)?price\s*[:\-]?\s*)?((?:₹|Rs\.?)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?)$/i);
            if (match) return match[1];
          }
          return '';
        };
        const priceTextOf = node => textOf(node) || accessiblePriceText(node);
        const normalizeProductName = value => collapse(String(value || ''))
          .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const formatInrAmount = raw => {
          const value = String(raw ?? '').replace(/,/g, '').trim();
          if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return '';
          const number = Number(value);
          if (!Number.isFinite(number) || number <= 0 || number > 100000000) return '';
          const [wholeRaw, fractionRaw = ''] = value.split('.');
          const whole = String(Number(wholeRaw));
          const fraction = fractionRaw.replace(/0+$/, '');
          return `₹${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
        };
        const productTitleNode = document.querySelector('#productTitle');
        const selectedTitle = textOf(productTitleNode) || title;
        const primaryPriceSelectors = [
          '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
          '#corePriceDisplay_mobile_feature_div .priceToPay .a-offscreen',
          '#corePrice_feature_div .priceToPay .a-offscreen',
          '#corePriceDisplay_desktop_feature_div .apexPriceToPay .a-offscreen',
          '#corePriceDisplay_mobile_feature_div .apexPriceToPay .a-offscreen',
          '#corePrice_feature_div .apexPriceToPay .a-offscreen',
          '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen',
          '#corePriceDisplay_mobile_feature_div .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen',
          '#corePrice_feature_div .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen',
          '#apex_desktop .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen',
          '#desktop_buybox .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen',
          '#buybox_feature_div .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen',
          '#price .a-price:not(.a-text-price):not(.basisPrice) .a-offscreen',
          '#priceblock_dealprice', '#priceblock_ourprice', '#price_inside_buybox'
        ];
        let currentPriceText = '';
        for (const selector of primaryPriceSelectors) {
          let nodes = [];
          try { nodes = Array.from(document.querySelectorAll(selector)); } catch {}
          const node = nodes.find(candidate => {
            // Amazon intentionally clips .a-offscreen text for screen readers. The
            // amount is still the primary product price; test visibility on its
            // rendered price container, not on the accessibility span itself.
            const priceContainer = candidate.closest('.a-price, .priceToPay, .apexPriceToPay') || candidate;
            if (!visible(priceContainer)) return false;
            const value = priceTextOf(candidate);
            if (!/^(?:₹\s*|Rs\.?\s*)[0-9][0-9,]*(?:\.[0-9]{1,2})?$/.test(value)) return false;
            if (candidate.closest('.a-text-price, .basisPrice, del, s, [class*="strike"], [class*="list-price"], [class*="was-price"]')) return false;
            return true;
          });
          if (node) {
            const match = priceTextOf(node).match(/^(?:₹\s*|Rs\.?\s*)([0-9][0-9,]*)(?:\.([0-9]{1,2}))?$/);
            if (match) {
              const whole = match[1].replace(/,/g, '');
              const fraction = (match[2] || '').replace(/0+$/, '');
              const amount = fraction ? `${whole}.${fraction}` : whole;
              currentPriceText = `₹${amount.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
              break;
            }
          }
        }
        // Amazon has several page templates. If the known dedicated selector ids above
        // are absent on a template, use only current-price spans inside a small set of
        // primary buy-box roots, then rank by proximity to the selected product title.
        // This is deliberately not a page-wide scan: ads, recommendations and variant
        // cards must never become a substitute price.
        if (!currentPriceText) {
          const titleRect = productTitleNode?.getBoundingClientRect?.();
          const roots = [];
          for (const selector of ['#corePriceDisplay_desktop_feature_div', '#corePriceDisplay_mobile_feature_div', '#corePrice_feature_div', '#apex_desktop', '#desktop_buybox', '#buybox_feature_div', '#price']) {
            try { roots.push(...Array.from(document.querySelectorAll(selector))); } catch {}
          }
          const uniqueRoots = Array.from(new Set(roots));
          const rejectedAncestor = node => {
            let current = node;
            for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
              const marker = `${String(current.id || '')} ${String(current.className?.baseVal || current.className || '')} ${current.getAttribute?.('aria-label') || ''}`;
              if (/(?:sponsored|advert|recommend|related|similar|carousel|recently[-_ ]?viewed|frequently[-_ ]?bought|customer[-_ ]?also)/i.test(marker)) return true;
              if (current.matches?.('del, s, .a-text-price, .basisPrice, [class*="strike"], [class*="list-price"], [class*="was-price"]')) return true;
            }
            return false;
          };
          const fallbackNodes = [];
          for (const root of uniqueRoots) {
            if (!visible(root)) continue;
            try { fallbackNodes.push(...Array.from(root.querySelectorAll('.a-price .a-offscreen, .priceToPay .a-offscreen, .apexPriceToPay .a-offscreen, [aria-label*="₹"], [aria-label*="Rs"]'))); } catch {}
          }
          const candidates = Array.from(new Set(fallbackNodes)).map(candidate => {
            const container = candidate.closest('.a-price, .priceToPay, .apexPriceToPay') || candidate;
            if (!visible(container) || rejectedAncestor(candidate)) return null;
            const raw = priceTextOf(candidate);
            const match = raw.match(/^(?:₹\s*|Rs\.?\s*)([0-9][0-9,]*)(?:\.([0-9]{1,2}))?$/);
            if (!match) return null;
            const rect = container.getBoundingClientRect?.();
            const topDistance = titleRect && rect ? Math.abs(Number(rect.top || 0) - Number(titleRect.top || 0)) : 0;
            const leftDistance = titleRect && rect ? Math.max(0, Number(titleRect.left || 0) - Number(rect.right || 0), Number(rect.left || 0) - Number(titleRect.right || 0)) : 0;
            if (titleRect && (topDistance > 1800 || leftDistance > 900)) return null;
            const amount = match[1].replace(/,/g, '') + ((match[2] || '').replace(/0+$/, '') ? `.${(match[2] || '').replace(/0+$/, '')}` : '');
            const formatted = `₹${amount.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
            let score = topDistance * 1.3 + leftDistance + raw.length / 8;
            if (container.closest('#corePriceDisplay_desktop_feature_div, #corePriceDisplay_mobile_feature_div, #corePrice_feature_div, #apex_desktop')) score -= 250;
            return { formatted, score };
          }).filter(Boolean).sort((a, b) => a.score - b.score);
          currentPriceText = candidates[0]?.formatted || '';
        }
        // Amazon occasionally removes or changes the usual buy-box price markup while
        // leaving a matching Product/Offer record in JSON-LD. Use only a direct Offer.price
        // from a Product object already matched to this selected page title. Do not treat
        // AggregateOffer.lowPrice as the selected variant's current price.
        if (!currentPriceText) {
          const selectedName = normalizeProductName(selectedTitle);
          const productNameMatches = productObject => {
            const candidateName = normalizeProductName(productObject?.name || productObject?.productName || productObject?.model);
            if (!candidateName || !selectedName) return false;
            const capacities = selectedName.match(/\b(\d{1,2})\s*gb\b.*?\b(\d{2,4})\s*gb\b/);
            if (capacities) {
              const [, ramCapacity, storageCapacity] = capacities;
              if (!new RegExp(`\\b${ramCapacity}\\s*gb\\b`).test(candidateName) || !new RegExp(`\\b${storageCapacity}\\s*gb\\b`).test(candidateName)) return false;
            }
            // If the selected title contains a likely color/variant before the capacity,
            // require the offer name to identify it too. This prevents the same phone model
            // but a different variant from contributing its price.
            const parenthesizedVariant = String(selectedTitle.match(/\(([^)]{1,100})\)/)?.[1] || '');
            const leadingVariant = parenthesizedVariant.split(',')[0].trim();
            if (/^[a-z][a-z -]{2,30}$/i.test(leadingVariant) && /\b(?:black|white|blue|green|olive|silver|gold|grey|gray|pink|purple|orange|red|graphite|titan|mint|lavender|ice|starlight)\b/i.test(leadingVariant)) {
              const normalizedVariant = normalizeProductName(leadingVariant);
              if (!candidateName.includes(normalizedVariant)) return false;
            }
            if (candidateName === selectedName || candidateName.includes(selectedName) || selectedName.includes(candidateName)) return candidateName.length >= Math.min(18, selectedName.length * 0.55);
            // Model-only matches are unsafe for price because storage/RAM variants may
            // have different prices. A model-only Product object cannot supply the amount.
            return false;
          };
          const offerList = offers => Array.isArray(offers) ? offers : (offers && typeof offers === 'object' ? [offers] : []);
          const structuredPriceCandidates = [];
          for (const productObject of jsonLdPriceProductObjects) {
            if (!productNameMatches(productObject)) continue;
            for (const offer of offerList(productObject.offers)) {
              const currency = String(offer?.priceCurrency || productObject?.priceCurrency || 'INR').toUpperCase();
              if (currency !== 'INR' && currency !== '₹') continue;
              // Direct Offer.price only. lowPrice/highPrice may describe a range of variants.
              const formatted = formatInrAmount(offer?.price);
              if (!formatted) continue;
              const availability = String(offer?.availability || '').toLowerCase();
              if (/outofstock|soldout|discontinued/.test(availability)) continue;
              structuredPriceCandidates.push({ formatted, exact: normalizeProductName(productObject?.name) === selectedName });
            }
          }
          structuredPriceCandidates.sort((a, b) => Number(b.exact) - Number(a.exact));
          currentPriceText = structuredPriceCandidates[0]?.formatted || '';
        }
        // Last-resort Amazon fallback: some layouts expose the selected ASIN's price only
        // in an explicit “This item” card rather than in a recognized buy-box container.
        // Restrict this to the ASIN from the current /dp/ URL, never arbitrary price spans.
        if (!currentPriceText) {
          const asin = (location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i) || [])[1] || '';
          if (asin) {
            let sameAsinRoots = [];
            try { sameAsinRoots = Array.from(document.querySelectorAll(`[data-asin="${asin}"]`)); } catch {}
            const sameAsinPrices = [];
            for (const root of sameAsinRoots) {
              const rootText = collapse(root.innerText || root.textContent || '');
              // A root with the exact ASIN from the selected /dp/ URL is product-specific,
              // even when Amazon places it inside a “This item” / frequently-bought-together
              // layout. Do not use cards for other ASINs as a price substitute.
              if (!rootText || !visible(root)) continue;
              const brandAndModel = selectedTitle.match(/\b(?:Samsung Galaxy [A-Z0-9]+|iQOO [A-Z0-9]+|OPPO [A-Z0-9]+|Nothing Phone \([A-Za-z0-9]+\))\b/i)?.[0] || selectedTitle;
              if (!normalizeProductName(rootText).includes(normalizeProductName(brandAndModel))) continue;
              let priceNodes = [];
              try { priceNodes = Array.from(root.querySelectorAll('.a-price .a-offscreen, [data-a-color="price"] .a-offscreen, [itemprop="price"][content], [itemprop="price"], [aria-label*="₹"], [aria-label*="Rs"]')); } catch {}
              for (const node of priceNodes) {
                if (node.closest('.a-text-price, .basisPrice, del, s, [class*="strike"], [class*="list-price"], [class*="was-price"]')) continue;
                let ancestor = node;
                let adOrStale = false;
                for (let depth = 0; ancestor && depth < 6; depth += 1, ancestor = ancestor.parentElement) {
                  const marker = `${String(ancestor.id || '')} ${String(ancestor.className?.baseVal || ancestor.className || '')} ${ancestor.getAttribute?.('aria-label') || ''}`;
                  if (/(?:sponsored|advertisement|adslot|ad-slot)/i.test(marker)) { adOrStale = true; break; }
                }
                if (adOrStale) continue;
                const raw = collapse(node.getAttribute?.('content') || priceTextOf(node) || '');
                const match = raw.match(/^(?:(?:₹|Rs\.?)\s*)?([0-9][0-9,]*(?:\.[0-9]{1,2})?)$/i);
                if (!match || (!/₹|Rs\.?/i.test(raw) && !node.matches?.('[itemprop="price"][content], [itemprop="price"]'))) continue;
                const formatted = formatInrAmount(match[1]);
                if (formatted) sameAsinPrices.push(formatted);
              }
            }
            const uniqueSameAsinPrices = Array.from(new Set(sameAsinPrices));
            if (uniqueSameAsinPrices.length === 1) currentPriceText = uniqueSameAsinPrices[0];
          }
        }
        // Compatibility fallback restored from the original private implementation.
        // The current build's known buy-box selectors can miss an Amazon template that still
        // exposes the selected offer through data-a-color, itemprop, or split price spans.
        // Search only price-like nodes, reject MRP/struck-through and ad/variant modules, and
        // rank the survivors by closeness to the selected product title. Never scan every
        // monetary amount on the page and choose by magnitude.
        if (!currentPriceText) {
          const fallbackTitleRect = productTitleNode?.getBoundingClientRect?.();
          const legacySelectors = [
            '[data-a-color="price"]',
            '[itemprop="price"]',
            '[data-testid*="price"]',
            '[class*="priceToPay"]',
            '[class*="price-to-pay"]',
            '[class*="currentPrice"]',
            '[class*="current-price"]',
            '[class*="sellingPrice"]',
            '[class*="selling-price"]',
            '[class*="dealPrice"]',
            '[class*="deal-price"]',
            '[class*="salePrice"]',
            '[class*="sale-price"]',
            '[class*="product-price"]',
            '.a-price',
            '.a-price-whole'
          ];
          const fallbackRoots = [
            '#corePriceDisplay_desktop_feature_div',
            '#corePriceDisplay_mobile_feature_div',
            '#corePrice_feature_div',
            '#apex_desktop',
            '#desktop_buybox',
            '#buybox_feature_div',
            '#price',
            '#centerCol',
            '#rightCol',
            '#ppd',
            '#dp-container',
            'main',
            '[role="main"]'
          ];
          const findClosest = (node, selector) => {
            try { return node?.closest?.(selector) || null; } catch { return null; }
          };
          const fallbackIsExcluded = node => {
            let current = node;
            for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
              const marker = `${String(current.id || '')} ${String(current.className?.baseVal || current.className || '')} ${current.getAttribute?.('aria-label') || ''}`;
              if (/(?:sponsored|advert(?:isement|ising)?|recommend|related|similar|carousel|recently[-_ ]?viewed|frequently[-_ ]?bought|customer[-_ ]?also|search[-_ ]?result|twister|variation|swatch|dimension[-_ ]?selection)/i.test(marker)) return true;
              if (current.matches?.('del, s, .a-text-price, .basisPrice, [class*="strike"], [class*="list-price"], [class*="was-price"], [class*="mrp"]')) return true;
              try {
                if (typeof getComputedStyle === 'function' && /line-through/i.test(getComputedStyle(current).textDecorationLine || '')) return true;
              } catch {}
            }
            return false;
          };
          const formatFallbackCurrencyText = raw => {
            const text = collapse(String(raw || '').replace(/\u00a0/g, ' '));
            const matches = Array.from(text.matchAll(/(?:₹\s*|Rs\.?\s*|\bINR\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi));
            if (matches.length !== 1) return '';
            return formatInrAmount(matches[0][1]);
          };
          const readFallbackPrice = candidate => {
            const priceContainer = findClosest(candidate, '.a-price, .priceToPay, .apexPriceToPay, [data-a-color="price"]') || candidate;
            if (!visible(priceContainer) || fallbackIsExcluded(candidate) || fallbackIsExcluded(priceContainer)) return '';

            const aPrice = findClosest(candidate, '.a-price') || (candidate.matches?.('.a-price') ? candidate : null);
            if (aPrice) {
              // Many Amazon templates split the amount into symbol/whole/fraction spans and
              // omit .a-offscreen. Reconstruct that rendered amount before reading generic text.
              const accessible = aPrice.querySelector?.('.a-offscreen');
              if (accessible) {
                const accessibleText = textOf(accessible) || accessiblePriceText(accessible);
                const formatted = formatFallbackCurrencyText(accessibleText);
                if (formatted) return formatted;
              }
              const wholeNode = aPrice.querySelector?.('.a-price-whole');
              if (wholeNode) {
                const whole = collapse(textOf(wholeNode)).replace(/[^0-9,]/g, '');
                const fractionNode = aPrice.querySelector?.('.a-price-fraction');
                const fraction = collapse(textOf(fractionNode)).replace(/[^0-9]/g, '').slice(0, 2);
                if (whole) {
                  const formatted = formatInrAmount(`${whole.replace(/,/g, '')}${fraction ? `.${fraction}` : ''}`);
                  if (formatted) return formatted;
                }
              }
            }

            // Prefer explicit accessibility/microdata fields. Microdata content is numeric
            // on some Amazon layouts, so only treat a bare numeric value as INR for itemprop=price.
            for (const node of [candidate, priceContainer]) {
              const aria = node?.getAttribute?.('aria-label');
              const fromAria = formatFallbackCurrencyText(aria);
              if (fromAria) return fromAria;
              const content = node?.getAttribute?.('content');
              if (content && node?.getAttribute?.('itemprop')?.toLowerCase() === 'price') {
                const fromContent = formatInrAmount(content);
                if (fromContent) return fromContent;
              }
            }
            const raw = textOf(candidate);
            const fromRaw = formatFallbackCurrencyText(raw);
            if (fromRaw) return fromRaw;
            if (candidate.matches?.('[itemprop="price"]')) {
              const numeric = formatInrAmount(raw);
              if (numeric) return numeric;
            }
            if (candidate.matches?.('.a-price')) {
              const fromContainer = formatFallbackCurrencyText(textOf(priceContainer));
              if (fromContainer) return fromContainer;
            }
            return '';
          };
          const fallbackCandidates = [];
          const seenFallbackNodes = new Set();
          let rejectedOrAmbiguousPriceSignal = false;
          for (const selector of legacySelectors) {
            let nodes = [];
            try { nodes = Array.from(document.querySelectorAll(selector)); } catch {}
            for (const node of nodes) {
              if (seenFallbackNodes.has(node)) continue;
              seenFallbackNodes.add(node);
              const rawCandidateText = [
                textOf(node), node.getAttribute?.('aria-label'), node.getAttribute?.('content'),
                node.getAttribute?.('value')
              ].filter(Boolean).join(' ');
              const carriesMoney = /(?:₹|Rs\.?|\bINR\b)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/i.test(rawCandidateText);
              const formatted = readFallbackPrice(node);
              if (!formatted) {
                if (carriesMoney) rejectedOrAmbiguousPriceSignal = true;
                continue;
              }
              const container = findClosest(node, '.a-price, .priceToPay, .apexPriceToPay, [data-a-color="price"]') || node;
              const rect = container.getBoundingClientRect?.();
              const titleRect = fallbackTitleRect;
              const topDistance = titleRect && rect ? Math.abs(Number(rect.top || 0) - Number(titleRect.top || 0)) : 0;
              const leftDistance = titleRect && rect ? Math.max(0, Number(rect.left || 0) - Number(titleRect.right || 0), Number(titleRect.left || 0) - Number(rect.right || 0)) : 0;
              if (titleRect && (topDistance > 1900 || leftDistance > 1000)) continue;
              let score = topDistance * 1.2 + leftDistance;
              if (findClosest(node, '#corePriceDisplay_desktop_feature_div, #corePriceDisplay_mobile_feature_div, #corePrice_feature_div, #apex_desktop, #desktop_buybox, #buybox_feature_div, #price')) score -= 700;
              else if (findClosest(node, '[data-a-color="price"]')) score -= 250;
              if (findClosest(node, '#centerCol, #rightCol, #ppd, #dp-container, main, [role="main"]')) score -= 100;
              if (node.matches?.('.a-price, .a-price-whole')) score -= 20;
              fallbackCandidates.push({ formatted, score });
            }
          }
          fallbackCandidates.sort((a, b) => a.score - b.score);
          if (fallbackCandidates.length) {
            // Collapse duplicate selector hits for the same amount. If equally plausible
            // candidates disagree and no dedicated buy-box signal distinguishes them, stay unknown.
            const best = fallbackCandidates[0];
            const conflicting = fallbackCandidates.find(candidate => candidate.formatted !== best.formatted && candidate.score - best.score < 45);
            if (!conflicting || best.score <= -150) currentPriceText = best.formatted;
          }

          // Last resort: restore the original visible-line fallback, but only inside the
          // selected product's content region. Accept either an explicit price label or a
          // standalone amount line; never use MRP, financing, cashback, coupon, or exchange text.
          if (!currentPriceText && !rejectedOrAmbiguousPriceSignal) {
            let textRoot = null;
            for (const selector of fallbackRoots) {
              try { textRoot = document.querySelector(selector); } catch {}
              if (textRoot && visible(textRoot)) break;
            }
            if (textRoot) {
              const lines = String(textRoot.innerText || '').split(/\r?\n/).map(line => collapse(line)).filter(Boolean);
              const linePrices = [];
              for (const line of lines) {
                if (/\b(?:mrp|m\.r\.p\.?|list price|maximum retail price|emi|per month|monthly|cashback|coupon|exchange|saving|save|delivery|shipping|sponsored|starting at)\b/i.test(line)) continue;
                const priceLabel = /\b(?:current|sale|selling|deal|offer|our|listed)?\s*price\b/i.test(line);
                const formatted = formatFallbackCurrencyText(line);
                if (!formatted) continue;
                if (!priceLabel && !/^(?:₹|Rs\.?\s*)[0-9][0-9,]*(?:\.[0-9]{1,2})?$/.test(line)) continue;
                linePrices.push({ formatted, explicit: priceLabel });
              }
              const explicitPrices = Array.from(new Set(linePrices.filter(item => item.explicit).map(item => item.formatted)));
              const allPrices = Array.from(new Set(linePrices.map(item => item.formatted)));
              if (explicitPrices.length === 1) currentPriceText = explicitPrices[0];
              else if (explicitPrices.length === 0 && allPrices.length === 1) currentPriceText = allPrices[0];
            }
          }
        }

        // If the selected product's primary price, matched offer, selected-page DOM fallback,
        // and same-ASIN fallback are unavailable, leave it unknown rather than guessing from cards.
        const pricingText = `[product pricing]\nSelected product: ${selectedTitle}\nCurrent listed price: ${currentPriceText || 'not detected'}`;
        productParts.push(pricingText);
        productLength += pricingText.length;
      }

      // Flipkart renders the selected phone price in retailer-specific classes rather
      // than Amazon's corePrice containers. Capture one price nearest the product title
      // as a dedicated section so variant cards, ads, and campaign headlines cannot
      // silently replace the selected product's current price.
      if (/(^|\.)flipkart\.com$/i.test(location.hostname)) {
        const isVisible = node => Boolean(node && node.getClientRects && node.getClientRects().length && !node.closest('[hidden], [aria-hidden="true"]'));
        const nodeText = node => collapse(node?.innerText || node?.textContent || "");
        const titleNode = Array.from(document.querySelectorAll("h1")).find(node => isVisible(node) && nodeText(node).length >= 8 && nodeText(node).length <= 220)
          || Array.from(document.querySelectorAll('[class*="VU-ZEz"], [class*="productTitle"], [class*="product-title"]')).find(node => isVisible(node) && nodeText(node).length >= 8 && nodeText(node).length <= 220);
        const titleText = nodeText(titleNode).slice(0, 220);
        const commonAncestor = (left, right) => {
          if (!left || !right) return null;
          const ancestors = new Set();
          let node = left;
          while (node) { ancestors.add(node); node = node.parentElement; }
          node = right;
          while (node && !ancestors.has(node)) node = node.parentElement;
          return node || null;
        };
        const structuralDistance = (left, right) => {
          if (!left || !right) return 1000;
          const ancestors = new Map();
          let node = left, depth = 0;
          while (node) { ancestors.set(node, depth++); node = node.parentElement; }
          node = right; depth = 0;
          while (node) {
            if (ancestors.has(node)) return ancestors.get(node) + depth;
            depth++;
            node = node.parentElement;
          }
          return 1000;
        };
        const collectPriceNodes = selector => {
          try { return Array.from(document.querySelectorAll(selector)); } catch { return []; }
        };
        // Prefer Flipkart's known price classes, but also inspect simple text elements.
        // Its CSS class names and container nesting change, and a strict shared-ancestor
        // check caused legitimate prices to be discarded on some live product pages.
        const preferredPriceNodes = collectPriceNodes('[class*="Nx9bqj"], [class*="_30jeq3"]');
        const fallbackPriceNodes = collectPriceNodes('[class*="price"], [class*="Price"]');
        const textPriceNodes = collectPriceNodes('span, div, p, strong, b');
        const priceNodes = Array.from(new Set([...preferredPriceNodes, ...fallbackPriceNodes, ...textPriceNodes]));
        const titleRect = titleNode?.getBoundingClientRect?.();
        const isCrossedOut = node => {
          let current = node;
          for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
            const className = String(current.className?.baseVal || current.className || "");
            if (/(?:mrp|strike|strikethrough|original|old[-_ ]?price|list[-_ ]?price)/i.test(className)) return true;
            if (current.matches?.('del, s, [style*="line-through"]')) return true;
            try {
              if (typeof getComputedStyle === "function" && /line-through/i.test(getComputedStyle(current).textDecorationLine || "")) return true;
            } catch {}
          }
          return false;
        };
        const priceCandidates = priceNodes.map(node => {
          const text = nodeText(node);
          const className = String(node.className?.baseVal || node.className || "");
          const match = text.match(/^₹\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?$/);
          if (!isVisible(node) || !match || text.length > 70 || isCrossedOut(node)) return null;
          const amountText = match[0].replace(/\s+/g, " ").trim();
          const rect = node.getBoundingClientRect?.();
          const titleBottom = Number(titleRect?.bottom || 0);
          const priceTop = Number(rect?.top || 0);
          const priceLeft = Number(rect?.left || 0);
          const titleLeft = Number(titleRect?.left || priceLeft);
          const titleRight = Number(titleRect?.right || titleLeft);
          const horizontalDistance = priceLeft > titleRight ? priceLeft - titleRight : titleLeft > Number(rect?.right || priceLeft) ? titleLeft - Number(rect?.right || priceLeft) : 0;
          const verticalDistance = priceTop - titleBottom;
          const ancestor = commonAncestor(titleNode, node);
          // Use rendered geometry rather than DOM order: Flipkart can place the price
          // container before the title in its DOM while CSS renders it beneath the title.
          // Geometric filtering still rejects ads and variant cards above the product.
          if (titleNode && (verticalDistance < -4 || verticalDistance > 1100 || horizontalDistance > 850)) return null;
          let score = Math.max(0, verticalDistance) * 2 + horizontalDistance + structuralDistance(titleNode, node) * 1.5 + text.length / 10;
          if (/(?:Nx9bqj|_30jeq3)/i.test(className)) score -= 40;
          if (!ancestor || ancestor === document.body || ancestor === document.documentElement) score += 20;
          return { node, amountText, score };
        }).filter(Boolean).sort((a, b) => a.score - b.score);
        const bestPrice = priceCandidates[0];
        let currentPriceText = bestPrice?.amountText || "";
        // If the visible primary price cannot be identified, keep it unknown rather than
        // substituting structured metadata that may describe another offer or variant.
        if (titleText) {
          // Keep this section even when no dependable price is detected. The worker uses
          // its presence to reject campaign/title prices instead of presenting them as verified.
          const pricingText = `[product pricing]\nSelected product: ${titleText}\nCurrent listed price: ${currentPriceText || "not detected"}`;
          productParts.push(pricingText);
          productLength += pricingText.length;
        }
      }

      for (const [label, selector, productScoped] of sectionGroups) {
        let nodes = [];
        try { nodes = Array.from(document.querySelectorAll(selector)); } catch {}
        for (const node of nodes) {
          const content = collapse(node.innerText || node.textContent);
          if (content.length < 24 && label !== "product pricing") continue;
          const key = content.toLowerCase();
          if (productScoped && !seenProductParts.has(key) && productLength < 24000) {
            // Keep explicit product-detail sections separate from the broader page body.
            // Recommendation cards often appear in the broader body and must not supply
            // deterministic product-specific facts for the selected product.
            const keptProduct = content.slice(0, Math.min(9000, 24000 - productLength));
            if (keptProduct) {
              productParts.push(`[${label}]\n${keptProduct}`);
              productLength += keptProduct.length;
              seenProductParts.add(key);
            }
          }
          if (seenParts.has(key) || primaryParts.some(part => part.toLowerCase().includes(key) || key.includes(part.toLowerCase()))) continue;
          // Keep a larger search copy before applying the smaller model input budget.
          // The evidence sweep below can then find claims deep inside long product sections.
          const searchRemaining = 60000 - searchLength;
          if (searchRemaining > 0) {
            const searchable = content.slice(0, searchRemaining);
            searchParts.push(`[${label}]\n${searchable}`);
            searchLength += searchable.length;
          }
          const remaining = 12000 - primaryLength;
          if (remaining > 0) {
            const kept = content.slice(0, Math.min(5000, remaining));
            primaryParts.push(`[${label}]\n${kept}`);
            primaryLength += kept.length;
          }
          seenParts.add(key);
        }
      }
      // Keep only explicit product-detail selectors in productSections. Generic headings
      // and broad main content stay in the other evidence fields, where attribution checks
      // can reject recommendation cards rather than treating the whole area as product data.
      const primarySections = primaryParts.join("\n\n");
      const primarySearchText = searchParts.join("\n\n");
      const productSections = productParts.join("\n\n");
      const isPhone = /\b(phone|smartphone|mobile|handset|android|iphone|galaxy|pixel)\b/i.test(`${title} ${location.href} ${decisionGoal}`);
      const evidencePatterns = [
        /\b\d+\s*[x×]\s*(?:major\s+)?(?:android\s+)?os\s+upgrades?\b/i,
        /\b\d+\s*(?:gen(?:eration)?s?)\s*(?:of\s*)?(?:android\s*)?os\s+(?:upgrades?|updates?)\b/i,
        /\b\d+\s+(?:major\s+)?(?:android\s+)?os\s+upgrades?\b/i,
        /\b\d+\s*years?\s*(?:of\s*)?(?:android\s+)?security\s+(?:updates?|patches)\b/i,
        /\bsecurity\s+(?:updates?|patches)\s+(?:for|up to)\s+\d+\s*years?\b/i,
        /\b\d+\s*years?\s*(?:of\s*)?(?:android\s*)?os\s+(?:upgrades?|updates?)\b/i,
        /\b(?:android\s*)?os\s+(?:upgrades?|updates?)\b/i,
        /\bsecurity\s+(?:updates?|patches|support)\b/i,
        // Include pricing on phone pages too; the old conditional omitted it for phones.
        /\b(?:current|discounted|sale|offer|list|original|regular|deal)\s+price\b|\bprice\b|\bmrp\b|₹\s*[\d,]+(?:\.\d{1,2})?|\b(?:INR|Rs\.?)\s*[\d,]+(?:\.\d{1,2})?/i,
        ...(isPhone ? [
          /\bbattery\s+(?:health|capacity|life|cycles?|replacement|degradation)\b/i,
          /\b\d{3,5}\s?mAh\b/i,
          /\b(?:warranty|guarantee|ip\s?\d{2}|water resistant|dust resistant|scratch resistant)\b/i,
          /\b(?:camera|megapixels?|\b\d+\s?MP\b|processor|chipset|AMOLED|sAMOLED|display|refresh rate)\b/i
        ] : [
          /\b(?:warranty|guarantee|refund|return policy|delivery|shipping)\b/i,
          /\b(?:price|discount|fees?|salary|placement|interest rate|annual fee|subscription)\b/i
        ])
      ];
      const goalStopWords = new Set(["about", "after", "again", "also", "among", "been", "being", "best", "choose", "from", "good", "have", "into", "make", "more", "need", "that", "their", "them", "then", "there", "these", "they", "this", "those", "want", "what", "when", "which", "with", "would", "years", "year"]);
      const goalTerms = [...new Set((String(decisionGoal || "").toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [])
        .filter(term => !goalStopWords.has(term) && !/^\d+$/.test(term)))].slice(0, 12);
      const collectSnippets = (source, patterns, maxChars) => {
        const snippets = [];
        const seen = new Set();
        let used = 0;
        for (const pattern of patterns) {
          const re = new RegExp(pattern.source, "ig");
          let match;
          let matchesForPattern = 0;
          while ((match = re.exec(source)) && matchesForPattern < 4) {
            const start = Math.max(0, match.index - 170);
            const end = Math.min(source.length, match.index + match[0].length + 230);
            const snippet = source.slice(start, end).trim();
            const key = snippet.toLowerCase();
            if (snippet && !seen.has(key) && used + snippet.length <= maxChars) {
              snippets.push(snippet);
              seen.add(key);
              used += snippet.length;
            }
            matchesForPattern += 1;
          }
        }
        const lowerSource = source.toLowerCase();
        for (const term of goalTerms) {
          if (used >= maxChars) break;
          const position = lowerSource.indexOf(term.toLowerCase());
          if (position < 0) continue;
          const start = Math.max(0, position - 140);
          const end = Math.min(source.length, position + term.length + 190);
          const snippet = source.slice(start, end).trim();
          const key = snippet.toLowerCase();
          if (snippet && !seen.has(key) && used + snippet.length <= maxChars) {
            snippets.push(snippet);
            seen.add(key);
            used += snippet.length;
          }
        }
        return snippets.join("\n[... relevant excerpt ...]\n");
      };
      const searchSource = primarySearchText || allText;
      let goalRelevantText = collectSnippets(searchSource, evidencePatterns, 8500);
      if (!goalRelevantText && allText && searchSource !== allText) {
        goalRelevantText = collectSnippets(allText, evidencePatterns, 8500);
      }
      // Preserve a little of the page's beginning and end as general context, but do not rely on either alone.
      const visibleText = allText.length > 10000
        ? `${allText.slice(0, 7000)}\n[... middle omitted; targeted page sections and relevant excerpts follow ...]\n${allText.slice(-2500)}`
        : allText;
      return {
        title,
        url: location.href,
        description: collapse(description).slice(0, 700),
        headings,
        structuredData,
        factSignals: factSignals.slice().sort((left, right) => {
          const rank = signal => {
            const label = String(signal?.attribute || '').toLowerCase();
            if (/display|screen|resolution|refresh rate|brightness|panel|ppi|pixel density|touchscreen|aspect ratio/.test(label)) return 0;
            if (/processor|chipset|ram|memory|storage|battery|camera|operating system|android|os upgrade|security update|warranty|weight|dimensions|ip rating|water resistance|dust resistance/.test(label)) return 1;
            if (/price|mrp|discount|offer/.test(label)) return 3;
            return 2;
          };
          return rank(left) - rank(right);
        }).slice(0, 180),
        productSections,
        primarySections,
        goalRelevantText,
        visibleText: visibleText.slice(0, 10000)
      };
    }
  });
  const page = result?.[0]?.result;
  if (page) {
  }
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
    factSignals: Array.isArray(page.factSignals) ? page.factSignals.slice(0, 180) : [],
    productSections: page.productSections || "",
    primarySections: page.primarySections || "",
    goalRelevantText: page.goalRelevantText || "",
    visibleText: page.visibleText || ""
  };
}

let startRequestPending = false;
let activeDecisionRunId = "";

async function clearDecisionRunLock(runId) {
  if (activeDecisionRunId === runId) activeDecisionRunId = "";
  const active = await chrome.storage.session.get("decideActiveRunId").catch(() => ({}));
  if (active.decideActiveRunId === runId) {
    await chrome.storage.session.remove("decideActiveRunId").catch(() => {});
  }
}

async function isCurrentRunActive(runId) {
  const { decideRun } = await chrome.storage.local.get("decideRun");
  return decideRun?.runId === runId && decideRun.status === "running";
}

async function beginDecision(message, sendResponse) {
  if (startRequestPending) {
    sendResponse({ ok: false, error: "A decision is already starting. Wait a moment and try again." });
    return;
  }
  startRequestPending = true;
  let responseSent = false;
  let runId = "";
  const respond = value => {
    if (responseSent) return;
    responseSent = true;
    sendResponse(value);
  };
  try {
    const goal = typeof message.goal === "string" ? message.goal.trim().slice(0, 1000) : "";
    const tabIds = Array.isArray(message.tabIds) ? [...new Set(message.tabIds.filter(Number.isInteger))].slice(0, 8) : [];
    if (!goal) { respond({ ok: false, error: "Write the decision you need to make first." }); return; }
    if (tabIds.length < 2) { respond({ ok: false, error: "Choose at least two pages so Decide has options to work with." }); return; }

    const [activeSession, storedState] = await Promise.all([
      chrome.storage.session.get("decideActiveRunId").catch(() => ({})),
      chrome.storage.local.get("decideRun")
    ]);
    const currentRun = storedState.decideRun;
    if (activeSession.decideActiveRunId || activeDecisionRunId) {
      respond({ ok: false, error: "A decision is already in progress. Wait for it to finish before starting another one." });
      return;
    }
    // A browser restart clears storage.session. If the durable record still says running
    // but no active-session lock exists, the prior run was interrupted and cannot resume.
    if (currentRun?.status === "running") {
      await setRun({
        ...currentRun,
        status: "error",
        stage: "The previous decision was interrupted.",
        error: "The browser session ended before this decision finished. Start a new decision to continue."
      });
    }

    runId = crypto.randomUUID();
    activeDecisionRunId = runId;
    await chrome.storage.session.set({ decideActiveRunId: runId });
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
    respond({ ok: true, runId });

    void (async () => {
      const errors = [];
      const pages = [];
      try {
        for (let i = 0; i < tabIds.length; i++) {
          const current = await chrome.storage.local.get("decideRun");
          if (current.decideRun?.runId !== runId || current.decideRun?.status === "cancelled") {
            await clearDecisionRunLock(runId);
            return;
          }
          await setRun({ ...current.decideRun, stage: `Reading page ${i + 1} of ${tabIds.length}…`, progress: { current: i, total: tabIds.length } });
          try { pages.push(await captureTab(tabIds[i], goal)); }
          catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }

          // Capture can take a while. Never hand a cancelled run to the AI worker,
          // including when the final page was the one being captured.
          if (!(await isCurrentRunActive(runId))) {
            await clearDecisionRunLock(runId);
            return;
          }
        }
        if (!(await isCurrentRunActive(runId))) {
          await clearDecisionRunLock(runId);
          return;
        }
        if (pages.length < 2) throw new Error(`Decide could only read ${pages.length} selected pages. Choose regular website tabs and check that they have finished loading. ${errors.join(" ")}`);
        await ensureOffscreen();
        const { decideSettings = {} } = await chrome.storage.local.get("decideSettings");
        // The final state check sits immediately before dispatch so cancellation
        // during offscreen setup or settings reads cannot start provider work.
        if (!(await isCurrentRunActive(runId))) {
          await clearDecisionRunLock(runId);
          return;
        }
        const response = await chrome.runtime.sendMessage({ type: "DECIDE_PROCESS", runId, goal, pages, captureErrors: errors, settings: decideSettings });
        if (response?.ok === false) throw new Error(response.error || "Could not start the decision worker.");
      } catch (error) {
        const current = await chrome.storage.local.get("decideRun");
        if (current.decideRun?.runId === runId && current.decideRun?.status !== "cancelled") {
          await setRun({ ...current.decideRun, status: "error", stage: "Decide could not finish this run.", error: error instanceof Error ? error.message : String(error), errors });
        }
        await clearDecisionRunLock(runId);
      }
    })();
  } catch (error) {
    if (runId) await clearDecisionRunLock(runId);
    respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    startRequestPending = false;
  }
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
      const patch = message.patch || {};
      if (Array.isArray(patch.extractedItems) || patch.result) {
        const items = Array.isArray(patch.extractedItems) ? patch.extractedItems : (decideRun.extractedItems || []);
        const result = patch.result || decideRun.result || {};
        const candidates = Array.isArray(result.candidates) ? result.candidates : [];
        const itemById = new Map(items.map(item => [item.id, item]));
      }
      await setRun({ ...decideRun, ...patch, runId: message.runId });
      sendResponse({ ok: true });
    })().catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "DECIDE_WORKER_FINISHED") {
    void clearDecisionRunLock(message.runId).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "DECIDE_WORKER_REJECT") {
    void (async () => {
      const { decideRun } = await chrome.storage.local.get("decideRun");
      if (decideRun?.runId === message.runId && decideRun.status === "running") {
        await setRun({ ...decideRun, status: "error", stage: "Decide could not start another run.", error: String(message.error || "Another decision is already running.") });
        await clearDecisionRunLock(message.runId);
      }
      sendResponse({ ok: true });
    })().catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "DECIDE_PROCESS") return false;
  return false;
});
