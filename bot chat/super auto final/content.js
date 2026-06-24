// content.js

(() => {
  if (globalThis.__CHATGPT_AUTO_PILOT_CONTENT_LOADED__) {
    return;
  }
  globalThis.__CHATGPT_AUTO_PILOT_CONTENT_LOADED__ = true;

  const MAX_WAIT_MS = 6 * 60 * 1000;
  const RESPONSE_CONTENT_CUE_STABLE_MS = 1500;
  const RESPONSE_STOPPED_STABLE_MS = 5000;
  const RESPONSE_STABLE_MS = 12000;
  const RESPONSE_UNFINISHED_STABLE_MS = 18000;
  const RESPONSE_HARD_STABLE_MS = 60000;
  const RESPONSE_STOPPED_GRACE_MS = 1000;
  const RESPONSE_POLL_MS = 500;
  const PROGRESS_PING_MIN_MS = 5000;
  const PROGRESS_HEARTBEAT_MS = 15000;
  const HEARTBEAT_PROGRESS_EVENTS = new Set([
    "waiting_for_composer",
    "waiting_for_send_button",
    "waiting_for_assistant",
    "response_generating",
    "response_waiting"
  ]);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let activeRunToken = 0;
  let activeJobId = null;
  let activeJobKind = null;
  let lastProgressSentAt = 0;

  let keepAlivePort = null;

  function connectKeepAlivePort() {
    if (keepAlivePort) return;
    try {
      keepAlivePort = chrome.runtime.connect({ name: "keepAlive" });
      keepAlivePort.onDisconnect.addListener(() => {
        keepAlivePort = null;
      });
    } catch (e) {
      // extension context invalidated
    }
  }

  function disconnectKeepAlivePort() {
    if (keepAlivePort) {
      try {
        keepAlivePort.disconnect();
      } catch (e) {}
      keepAlivePort = null;
    }
  }

  function pingKeepAlive() {
    if (!keepAlivePort) {
      connectKeepAlivePort();
    }
    if (keepAlivePort) {
      try {
        keepAlivePort.postMessage({ action: "ping" });
      } catch (e) {
        keepAlivePort = null;
      }
    }
  }

  const DEFAULT_SELECTORS = {
    composerSelectors: [
      "#prompt-textarea",
      "textarea[placeholder*='ChatGPT']",
      "textarea",
      "[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']"
    ],
    sendButtonSelectors: [
      "button[data-testid='send-button']",
      "button[data-testid='composer-send-button']",
      "button[data-testid*='send']",
      "button[aria-label='Send prompt']",
      "button[aria-label='Send message']",
      "button[aria-label*='Send']",
      "button[aria-label*='Gửi']",
      "button[title*='Send']",
      "button[title*='Gửi']",
      "button[type='submit']"
    ],
    scopedStreamingSelectors: [
      ".result-streaming",
      "[data-testid='result-streaming']",
      "[data-is-streaming='true']",
      "[data-streaming='true']",
      "[aria-busy='true']"
    ],
    pageStreamingSelectors: [
      ".result-streaming",
      "[data-testid='result-streaming']",
      "[data-is-streaming='true']",
      "[data-streaming='true']"
    ],
    stopButtonSelectors: [
      "button[data-testid='stop-button']",
      "button[data-testid='composer-stop-button']",
      "button[data-testid*='stop']",
      "button[aria-label='Stop generating']",
      "button[aria-label='Stop streaming']",
      "button[aria-label*='Stop']",
      "button[aria-label*='Dừng']",
      "button[title*='Stop']"
    ],
    assistantMessageSelectors: [
      "[data-message-author-role='assistant']"
    ]
  };

  let activeSelectors = {
    composerSelectors: [...DEFAULT_SELECTORS.composerSelectors],
    sendButtonSelectors: [...DEFAULT_SELECTORS.sendButtonSelectors],
    scopedStreamingSelectors: [...DEFAULT_SELECTORS.scopedStreamingSelectors],
    pageStreamingSelectors: [...DEFAULT_SELECTORS.pageStreamingSelectors],
    stopButtonSelectors: [...DEFAULT_SELECTORS.stopButtonSelectors],
    assistantMessageSelectors: [...DEFAULT_SELECTORS.assistantMessageSelectors]
  };

  function isValidSelector(selector) {
    if (typeof selector !== "string" || !selector.trim()) return false;
    try {
      document.createDocumentFragment().querySelector(selector);
      return true;
    } catch (e) {
      return false;
    }
  }

  function sendSelectorAlert(type) {
    chrome.runtime.sendMessage({
      action: "SELECTOR_HEARTBEAT_ALERT",
      issues: [type],
      healed: true,
      url: window.location.href,
      timestamp: Date.now()
    }, () => { void chrome.runtime.lastError; });
  }

  function updateSelectors(syncedSelectors) {
    if (!syncedSelectors) return;
    for (const key of Object.keys(DEFAULT_SELECTORS)) {
      if (Array.isArray(syncedSelectors[key]) && syncedSelectors[key].length > 0) {
        const validSynced = syncedSelectors[key].filter(isValidSelector);
        const hasBadSelector = validSynced.length < syncedSelectors[key].length;
        
        if (hasBadSelector) {
          sendSelectorAlert(`invalid_config_selector_${key}`);
        }
        
        const combined = validSynced.length > 0 ? [...validSynced] : [...DEFAULT_SELECTORS[key]];
        if (validSynced.length > 0) {
          for (const defSelector of DEFAULT_SELECTORS[key]) {
            if (!combined.includes(defSelector)) {
              combined.push(defSelector);
            }
          }
        }
        activeSelectors[key] = combined;
      }
    }
  }

  function verifyActiveSelectors() {
    const results = {
      composer: { ok: false, selector: null },
      sendButton: { ok: false, selector: null },
      assistantMessage: { ok: false, selector: null }
    };
    for (const selector of activeSelectors.composerSelectors) {
      try {
        if (document.querySelector(selector)) {
          results.composer = { ok: true, selector };
          break;
        }
      } catch (e) {
        sendSelectorAlert("composer");
      }
    }
    if (results.composer.ok) {
      let composer = null;
      try {
        composer = document.querySelector(results.composer.selector);
      } catch (e) {}
      
      const scopes = composer ? [
        composer.closest("form"),
        composer.closest("[data-testid='composer']"),
        composer.closest("main"),
        document
      ].filter(Boolean) : [document];
      
      for (const scope of scopes) {
        for (const selector of activeSelectors.sendButtonSelectors) {
          try {
            if (scope.querySelector(selector)) {
              results.sendButton = { ok: true, selector };
              break;
            }
          } catch (e) {
            sendSelectorAlert("sendButton");
          }
        }
        if (results.sendButton.ok) break;
      }
    } else {
      for (const selector of activeSelectors.sendButtonSelectors) {
        try {
          if (document.querySelector(selector)) {
            results.sendButton = { ok: true, selector };
            break;
          }
        } catch (e) {
          sendSelectorAlert("sendButton");
        }
      }
    }
    for (const selector of activeSelectors.assistantMessageSelectors) {
      try {
        if (document.querySelector(selector)) {
          results.assistantMessage = { ok: true, selector };
          break;
        }
      } catch (e) {
        sendSelectorAlert("assistantMessage");
      }
    }
    return results;
  }

  function runSelectorSelfHealingHeartbeat() {
    if (document.hidden || !window.location.href.includes("chatgpt.com")) return;
    const isChatPage = window.location.pathname.startsWith("/c/") || window.location.pathname === "/";
    if (!isChatPage) return;
    const checks = verifyActiveSelectors();
    let healed = false;
    let issues = [];
    if (!checks.composer.ok) {
      issues.push("composer");
      const defaultMatch = DEFAULT_SELECTORS.composerSelectors.some(s => {
        try {
          return document.querySelector(s);
        } catch (e) {
          return false;
        }
      });
      if (defaultMatch) {
        activeSelectors.composerSelectors = [...DEFAULT_SELECTORS.composerSelectors];
        healed = true;
      }
    }
    
    let composer = null;
    if (checks.composer.ok) {
      try {
        composer = document.querySelector(checks.composer.selector);
      } catch (e) {}
    }
    const composerHasText = composer ? normalizeTextForCompare(getComposerText(composer)).length > 0 : false;

    if (!checks.sendButton.ok && composerHasText) {
      issues.push("sendButton");
      const defaultMatch = DEFAULT_SELECTORS.sendButtonSelectors.some(s => {
        try {
          return document.querySelector(s);
        } catch (e) {
          return false;
        }
      });
      if (defaultMatch) {
        activeSelectors.sendButtonSelectors = [...DEFAULT_SELECTORS.sendButtonSelectors];
        healed = true;
      }
    }
    if (issues.length > 0) {
      chrome.runtime.sendMessage({
        action: "SELECTOR_HEARTBEAT_ALERT",
        issues,
        healed,
        url: window.location.href,
        timestamp: Date.now()
      }, () => { void chrome.runtime.lastError; });
    }
  }

  // Request selectors on start
  try {
    chrome.runtime.sendMessage({ action: "GET_SELECTORS" }, (response) => {
      if (response && response.selectors) {
        updateSelectors(response.selectors);
      }
    });
  } catch (e) {
    // Context invalidated
  }

  // Run heartbeat check every 15 seconds
  setInterval(runSelectorSelfHealingHeartbeat, 15000);

  class StaleJobError extends Error {
    constructor() {
      super("Stale job cancelled");
      this.name = "StaleJobError";
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.selectors) {
      updateSelectors(message.selectors);
    }

    if (message.action === "SYNC_CHAT_HISTORY") {
      try {
        const history = extractChatHistory();
        const assistantMessages = getAssistantMessages();
        const latestAssistant = assistantMessages[assistantMessages.length - 1] || null;
        sendResponse({
          success: true,
          history,
          generating: isGenerating(latestAssistant),
          visibilityState: document.visibilityState,
          hidden: document.hidden
        });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      return true;
    }

    if (message.action === "INPUT_AND_SEND") {
      const jobId = message.jobId || null;
      const runToken = ++activeRunToken;
      activeJobId = jobId;
      activeJobKind = message.jobKind || null;
      lastProgressSentAt = 0;

      processPrompt(message.prompt, runToken, jobId)
        .then((result) => {
          if (!isCurrentJob(runToken, jobId)) return;
          const response = result && typeof result === "object" ? result.text : result;
          const outlineSectionCount = result && typeof result === "object"
            ? Number(result.outlineSectionCount) || 0
            : 0;
          chrome.runtime.sendMessage({
            action: "RESPONSE_COMPLETE",
            jobId,
            response,
            outlineSectionCount,
            error: false
          });
        })
        .catch((error) => {
          if (error && error.name === "StaleJobError") return;
          if (!isCurrentJob(runToken, jobId)) return;
          chrome.runtime.sendMessage({
            action: "RESPONSE_COMPLETE",
            jobId,
            response: error.message,
            error: true
          });
        });

      sendResponse({ status: "started", jobId });
      return true;
    }

    return false;
  });


  function isCurrentJob(runToken, jobId) {
    return runToken === activeRunToken && jobId === activeJobId;
  }

  function assertCurrentJob(runToken) {
    if (runToken !== activeRunToken) {
      throw new StaleJobError();
    }
  }

  function reportJobProgress(runToken, jobId, event, details = {}) {
    if (!jobId || !isCurrentJob(runToken, jobId)) return;

    const now = Date.now();
    const throttleMs = event === "response_text"
      ? PROGRESS_PING_MIN_MS
      : (HEARTBEAT_PROGRESS_EVENTS.has(event) ? PROGRESS_HEARTBEAT_MS : 0);

    if (throttleMs && now - lastProgressSentAt < throttleMs) {
      return;
    }

    lastProgressSentAt = now;
    try {
      chrome.runtime.sendMessage({
        action: "JOB_PROGRESS",
        jobId,
        event,
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        ...details
      }, () => {
        // Touch lastError so Chrome does not surface an unchecked callback error.
        void chrome.runtime.lastError;
      });
    } catch {
      // Progress pings are best-effort. The main RESPONSE_COMPLETE message still owns completion.
    }
  }

  async function processPrompt(promptText, runToken, jobId) {
    connectKeepAlivePort();
    const pingInterval = setInterval(pingKeepAlive, 10000);
    try {
      const composer = await waitForComposer(runToken, jobId);
      assertCurrentJob(runToken);
      reportJobProgress(runToken, jobId, "composer_ready");
      const beforeCount = getAssistantMessages().length;

      setComposerText(composer, promptText);

      const sendButton = await waitForSendButton(composer, runToken, jobId);
      assertCurrentJob(runToken);
      sendButton.click();
      reportJobProgress(runToken, jobId, "prompt_sent");

      return await waitForNewAssistantResponse(beforeCount, promptText, runToken, jobId);
    } finally {
      clearInterval(pingInterval);
      disconnectKeepAlivePort();
    }
  }

  async function waitForComposer(runToken, jobId) {
    const deadline = Date.now() + 20000;

    while (Date.now() < deadline) {
      assertCurrentJob(runToken);
      reportJobProgress(runToken, jobId, "waiting_for_composer");
      const composer = findComposer();
      if (composer) return composer;
      throwIfBlockingPage();
      await sleep(300);
    }

    throw new Error("Khong tim thay khung nhap ChatGPT.");
  }

  function findComposer() {
    const selectors = activeSelectors.composerSelectors;

    for (const selector of selectors) {
      try {
        const elements = Array.from(document.querySelectorAll(selector));
        const visible = elements.find(isVisible);
        if (visible) return visible;
      } catch (e) {
        sendSelectorAlert("composer");
      }
    }

    return null;
  }

  function setComposerText(composer, text) {
    composer.focus();

    // Chuẩn hóa xuống dòng (thay thế \r\n hoặc \r bằng \n)
    const normalizedText = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    if (isTextInput(composer)) {
      const prototype = Object.getPrototypeOf(composer);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

      if (descriptor && descriptor.set) {
        descriptor.set.call(composer, normalizedText);
      } else {
        composer.value = normalizedText;
      }

      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    // Avoid synthetic paste: ChatGPT can convert large pasted text into a .txt attachment.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);

    document.execCommand("delete", false);
    const inserted = document.execCommand("insertText", false, normalizedText);

    if (!inserted || normalizeTextForCompare(getComposerText(composer)) !== normalizeTextForCompare(normalizedText)) {
      // Safe fallback: build the contenteditable content with DOM nodes instead
      // of assigning innerHTML, so model/Sheet-derived text can never be parsed
      // as HTML. Lines are separated by <br>, matching the prior layout.
      setComposerTextViaDom(composer, normalizedText);
    }

    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: normalizedText
    }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setComposerTextViaDom(composer, text) {
    while (composer.firstChild) {
      composer.removeChild(composer.firstChild);
    }

    const lines = String(text || "").split("\n");
    lines.forEach((line, index) => {
      if (index > 0) {
        composer.appendChild(document.createElement("br"));
      }
      if (line) {
        composer.appendChild(document.createTextNode(line));
      }
    });
  }

  function normalizeTextForCompare(text) {
    return String(text || "").replace(/\r\n?/g, "\n").trim();
  }

  function getComposerText(composer) {
    return isTextInput(composer) ? composer.value : (composer.innerText || composer.textContent || "");
  }

  function isTextInput(element) {
    const tag = element.tagName ? element.tagName.toLowerCase() : "";
    return tag === "textarea" || tag === "input";
  }

  async function waitForSendButton(composer, runToken, jobId) {
    const deadline = Date.now() + 60000;

    while (Date.now() < deadline) {
      assertCurrentJob(runToken);
      reportJobProgress(runToken, jobId, "waiting_for_send_button");
      const button = findSendButton(composer);
      if (button && !isDisabled(button)) return button;
      await sleep(250);
    }

    throw new Error("Khong tim thay nut gui ChatGPT hoac nut dang bi vo hieu hoa.");
  }

  function findSendButton(composer) {
    const scopes = [
      composer.closest("form"),
      composer.closest("[data-testid='composer']"),
      composer.closest("main"),
      document
    ].filter(Boolean);

    const selectors = activeSelectors.sendButtonSelectors;

    for (const scope of scopes) {
      for (const selector of selectors) {
        try {
          const button = Array.from(scope.querySelectorAll(selector)).find(isVisible);
          if (button) return button;
        } catch (e) {
          sendSelectorAlert("sendButton");
        }
      }
    }

    return null;
  }

  async function waitForNewAssistantResponse(beforeCount, promptText, runToken, jobId) {
    return new Promise((resolve, reject) => {
      let done = false;
      let lastText = "";
      let lastTextChangedAt = 0;
      let latestMessage = null;
      let lastOutlineSectionCount = 0;
      let observedGenerating = false;
      let reportedAssistantStarted = false;
      let reportedGenerationStopped = false;
      let generationStoppedAt = 0;
      let checkTimer = null;
      let stableTimer = null;

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        clearTimeout(checkTimer);
        clearTimeout(stableTimer);
        observer.disconnect();
      };

      const finish = (value) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(value);
      };

      const fail = (error) => {
        if (done) return;
        done = true;
        cleanup();
        reject(error);
      };

      const timeoutTimer = setTimeout(() => {
        fail(new Error("Qua thoi gian cho response moi tu ChatGPT."));
      }, MAX_WAIT_MS);

      const queueCheck = (delay = 80) => {
        if (done) return;
        clearTimeout(checkTimer);
        checkTimer = setTimeout(checkResponse, delay);
      };

      const observer = new MutationObserver(() => queueCheck());

      const checkResponse = () => {
        try {
          assertCurrentJob(runToken);

          const assistantMessages = getAssistantMessages();
          let newAssistantMessages = assistantMessages.slice(beforeCount);
          if (!newAssistantMessages.length) {
            const trackedAssistant = findAssistantMessageAfterPrompt(promptText);
            if (trackedAssistant) {
              newAssistantMessages = [trackedAssistant];
            }
          }
          throwIfChatGPTError(newAssistantMessages);

          if (!newAssistantMessages.length) {
            reportJobProgress(runToken, jobId, "waiting_for_assistant", {
              beforeCount
            });
            queueCheck(RESPONSE_POLL_MS);
            return;
          }

          if (!reportedAssistantStarted) {
            reportedAssistantStarted = true;
            reportJobProgress(runToken, jobId, "assistant_started", {
              assistantCount: newAssistantMessages.length
            });
          }

          latestMessage = newAssistantMessages[newAssistantMessages.length - 1];
          const text = getMessageText(latestMessage).trim();
          lastOutlineSectionCount = getOrderedListSectionCount(latestMessage);
          if (!text) {
            queueCheck(RESPONSE_POLL_MS);
            return;
          }

          if (text !== lastText) {
            lastText = text;
            lastTextChangedAt = Date.now();
            reportJobProgress(runToken, jobId, "response_text", {
              textLength: text.length
            });
          }

          const generating = isGenerating(latestMessage);
          if (generating) {
            observedGenerating = true;
            generationStoppedAt = 0;
            reportedGenerationStopped = false;
          } else if (observedGenerating && !generationStoppedAt) {
            generationStoppedAt = Date.now();
            if (!reportedGenerationStopped) {
              reportedGenerationStopped = true;
              reportJobProgress(runToken, jobId, "generation_stopped", {
                textLength: lastText.length
              });
            }
          }

          const stableFor = Date.now() - lastTextChangedAt;
          const stoppedFor = generationStoppedAt ? Date.now() - generationStoppedAt : 0;
          const hasCompletionCue = hasResponseCompletionCue(lastText);
          const stableWaitMs = getResponseStableWaitMs(lastText, hasCompletionCue, stoppedFor);
          const stoppedWaitMs = hasCompletionCue ? RESPONSE_STOPPED_GRACE_MS : RESPONSE_STOPPED_STABLE_MS;
          const stableEnough = stableFor >= stableWaitMs;
          const hardStable = stableFor >= RESPONSE_HARD_STABLE_MS;
          const stoppedEnough = observedGenerating
            ? stoppedFor >= stoppedWaitMs
            : stableEnough;
          if (stableEnough && ((!generating && stoppedEnough) || (hardStable && hasCompletionCue))) {
            finish({
              text: lastText.trim(),
              outlineSectionCount: lastOutlineSectionCount
            });
            return;
          }

          reportJobProgress(runToken, jobId, generating ? "response_generating" : "response_waiting", {
            textLength: lastText.length,
            stableSeconds: Math.round(stableFor / 1000),
            generating
          });

          const remainingWait = Math.max(stableWaitMs - stableFor, stoppedWaitMs - stoppedFor);
          const nextDelay = generating
            ? 500
            : Math.max(100, Math.min(500, remainingWait));
          clearTimeout(stableTimer);
          stableTimer = setTimeout(checkResponse, nextDelay);
        } catch (error) {
          fail(error);
        }
      };

      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-label", "aria-busy", "class", "data-testid", "disabled", "title"]
      });

      queueCheck(0);
    });
  }

  function getAssistantMessages() {
    const selectors = activeSelectors.assistantMessageSelectors;
    const elements = [];
    for (const selector of selectors) {
      try {
        elements.push(...Array.from(document.querySelectorAll(selector)));
      } catch (e) {
        sendSelectorAlert("assistantMessage");
      }
    }
    return elements.filter(isVisible);
  }

  function getMessageText(messageElement) {
    const markdown = messageElement.querySelector(".markdown") || messageElement;
    return markdown.innerText || markdown.textContent || "";
  }

  // Ordered-list numbers are often CSS markers and absent from innerText.
  // Count the actual DOM items, independent of the response language.
  function getOrderedListSectionCount(messageElement) {
    if (!messageElement || typeof messageElement.querySelectorAll !== "function") return 0;

    let largest = 0;
    const markdown = messageElement.querySelector(".markdown") || messageElement;
    Array.from(markdown.querySelectorAll("ol")).forEach((list) => {
      const directItems = Array.from(list.children || []).filter((child) =>
        child && String(child.tagName || "").toLowerCase() === "li"
      );
      largest = Math.max(largest, directItems.length);
    });

    return largest >= 2 ? largest : 0;
  }

  function findAssistantMessageAfterPrompt(promptText) {
    const elements = Array.from(document.querySelectorAll("[data-message-author-role]")).filter(isVisible);
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      if (el.getAttribute("data-message-author-role") !== "user") continue;
      if (!promptMatchesTrackedJob(getMessageText(el), promptText)) continue;

      for (let j = i + 1; j < elements.length; j++) {
        const nextEl = elements[j];
        const nextRole = nextEl.getAttribute("data-message-author-role");
        if (nextRole === "user") break;
        if (nextRole === "assistant" && getMessageText(nextEl).trim()) {
          return nextEl;
        }
      }
    }

    return null;
  }

  function promptMatchesTrackedJob(candidatePrompt, targetPrompt) {
    if (globalThis.AutoPilotLib && typeof globalThis.AutoPilotLib.promptMatchesTrackedJob === "function") {
      return globalThis.AutoPilotLib.promptMatchesTrackedJob(candidatePrompt, targetPrompt);
    }

    return normalizeText(candidatePrompt).replace(/\s+/g, " ").trim() ===
      normalizeText(targetPrompt).replace(/\s+/g, " ").trim();
  }

  function getResponseStableWaitMs(text, hasCompletionCue, stoppedFor) {
    if (hasCompletionCue) return RESPONSE_CONTENT_CUE_STABLE_MS;
    if (stoppedFor > 0) return RESPONSE_STOPPED_STABLE_MS;
    const isImagePrompt = activeJobKind === "image_prompt";
    return (isImagePrompt ? false : looksLikeUnfinishedResponse(text))
      ? RESPONSE_UNFINISHED_STABLE_MS
      : RESPONSE_STABLE_MS;
  }

  function hasResponseCompletionCue(text) {
    const cleaned = String(text || "").replace(/[*_`~]/g, " ").trim();
    const normalized = normalizeText(cleaned).replace(/\s+/g, " ");
    const hasWordCount = /\[?\s*(?:approx(?:imate|imately)?\s*)?word\s*count\s*[:.\-\)]?\s*(?:about\s*)?\d[\d,.\s]*(?:\s*words?)?\s*\]?/i.test(cleaned);
    const awaitsContinue = /\b(awaiting|waiting for|ready for|standing by for)\b.{0,80}\bcontinue\b/i.test(normalized);
    const finalDone = /end of script\.\s*sweet dreams\.?$/i.test(cleaned);

    return finalDone || (hasWordCount && awaitsContinue);
  }

  function looksLikeUnfinishedResponse(text) {
    const cleaned = String(text || "").trim();
    if (!cleaned) return true;

    const tail = cleaned.slice(-80).trim();
    if (!tail) return true;
    if (/```$/.test(cleaned)) return false;
    if (/[\.\?!:;\)"'\]\}\|\u201d\u2019]$/.test(tail)) return false;
    if (/end of script\.\s*sweet dreams\.?$/i.test(cleaned.replace(/[*_`~]/g, "").trim())) return false;
    return true;
  }

  function isGenerating(latestMessage = null) {
    const scopedStreamingSelectors = activeSelectors.scopedStreamingSelectors;
    const pageStreamingSelectors = activeSelectors.pageStreamingSelectors;
    const stopButtonSelectors = activeSelectors.stopButtonSelectors;

    if (latestMessage) {
      for (const selector of scopedStreamingSelectors) {
        try {
          if ((matchesSelector(latestMessage, selector) && isVisible(latestMessage)) ||
              Array.from(latestMessage.querySelectorAll(selector)).some(isVisible)) {
            return true;
          }
        } catch (e) {
          sendSelectorAlert("scopedStreaming");
        }
      }
    }

    for (const selector of pageStreamingSelectors) {
      try {
        if (Array.from(document.querySelectorAll(selector)).some(isVisible)) {
          return true;
        }
      } catch (e) {
        sendSelectorAlert("pageStreaming");
      }
    }

    for (const selector of stopButtonSelectors) {
      try {
        if (Array.from(document.querySelectorAll(selector))
            .some((element) => isVisible(element) && !isDisabled(element))) {
          return true;
        }
      } catch (e) {
        sendSelectorAlert("stopButton");
      }
    }

    return false;
  }

  function throwIfChatGPTError(scopeElements = []) {
    const scopedSelectors = "[role='alert'], .text-red-500, .bg-red-500, .text-orange-500, .bg-red-100, [class*='error']";
    const pageAlertSelectors = "[role='alert'], [data-testid*='toast'], [class*='toast']";
    const alertElements = [];

    scopeElements.forEach((scope) => {
      if (!scope) return;
      if (matchesSelector(scope, scopedSelectors)) alertElements.push(scope);
      alertElements.push(...scope.querySelectorAll(scopedSelectors));
    });

    document.querySelectorAll(pageAlertSelectors).forEach((element) => {
      if (!element.closest("[data-message-author-role]")) {
        alertElements.push(element);
      }
    });

    for (const element of alertElements) {
      const text = (element.innerText || element.textContent || "").trim();
      if (!text) continue;

      if (isChatGPTErrorText(text)) {
        throw new Error(text);
      }
    }
  }

  function isChatGPTErrorText(text) {
    if (globalThis.AutoPilotLib && typeof globalThis.AutoPilotLib.isChatGPTErrorText === "function") {
      return globalThis.AutoPilotLib.isChatGPTErrorText(text);
    }

    const normalized = normalizeText(text).replace(/\s+/g, " ").trim();
    const fallbackPatterns = [
      /\bsomething went wrong\b/,
      /\berror generating\b/,
      /\bplease try again\b/,
      /\bnetwork error\b/,
      /\btoo many requests\b/,
      /\bunusual activity\b/,
      /\bmessage limit\b/,
      /\brate limit(?:ed|ing)?\b/,
      /\bmessage cap\b/,
      /\bquota exceeded\b/,
      /\btry again (?:after|later)\b/,
      /loi mang/,
      /vui long thu lai/,
      /khong the tao/
    ];
    return fallbackPatterns.some((pattern) => pattern.test(normalized));
  }

  function matchesSelector(element, selector) {
    return element.matches && element.matches(selector);
  }

  function throwIfBlockingPage() {
    const pageText = normalizeText(document.body ? document.body.innerText : "");
    if (!pageText) return;

    const hasLoginText = pageText.includes("log in") ||
      pageText.includes("sign in") ||
      pageText.includes("dang nhap");
    const hasLoginButton = Array.from(document.querySelectorAll("button, a"))
      .some((element) => {
        const text = normalizeText(element.innerText || element.textContent || "");
        return text === "log in" || text === "sign in" || text === "dang nhap";
      });

    if (hasLoginText && hasLoginButton) {
      throw new Error("ChatGPT chua dang nhap hoac phien dang nhap da het han.");
    }
  }

  function normalizeText(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[đĐ]/g, "d")
      .toLowerCase();
  }

  function isDisabled(element) {
    return Boolean(
      element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      element.classList.contains("disabled")
    );
  }

  function isVisible(element) {
    if (!element) return false;
    if (element.closest && element.closest("[hidden], [aria-hidden='true']")) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.opacity !== "0";
  }

  function extractChatHistory() {
    const elements = Array.from(document.querySelectorAll("[data-message-author-role]")).filter(isVisible);
    const history = [];

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const role = el.getAttribute("data-message-author-role");
      if (role === "user") {
        const promptText = getMessageText(el).trim();
        let assistantText = "";
        for (let j = i + 1; j < elements.length; j++) {
          const nextEl = elements[j];
          const nextRole = nextEl.getAttribute("data-message-author-role");
          if (nextRole === "user") {
            break;
          }
          if (nextRole === "assistant") {
            assistantText = getMessageText(nextEl).trim();
            i = j;
            break;
          }
        }

        if (assistantText) {
          history.push({
            prompt: promptText,
            response: assistantText,
            outlineSectionCount: getOrderedListSectionCount(nextEl)
          });
        }
      }
    }

    return history;
  }
})();
