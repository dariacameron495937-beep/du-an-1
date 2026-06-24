// background.js

// Load shared pure helpers (maskSecretsInUrl, isRecoverableJobError, ...).
// Must run before the rest of the worker. importScripts is synchronous.
try {
  importScripts("lib.js");
} catch (e) {
  // If this throws, the worker cannot start safely; surface it loudly.
  console.error("Failed to load lib.js", e);
}

const ALARM_NEXT_PROMPT = "nextPromptAlarm";
const ALARM_JOB_TIMEOUT = "jobTimeoutAlarm";
const ALARM_JOB_WATCHDOG = "jobWatchdogAlarm";
const ALARM_SYNC_SELECTORS = "syncSelectorsAlarm";
const ALARM_WORKFLOW_HEARTBEAT = "workflowHeartbeatAlarm";
const RESPONSE_TIMEOUT_MS = 7 * 60 * 1000;
const JOB_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const JOB_GENERATING_IDLE_TIMEOUT_MS = 4 * 60 * 1000;
const JOB_FOREGROUND_REFRESH_MS = 45 * 1000;
const JOB_WATCHDOG_PERIOD_MINUTES = 1;
const WORKFLOW_HEARTBEAT_PERIOD_MINUTES = 1;
const WAITING_ASSISTANT_FAST_SYNC_MS = 45 * 1000;
const WAITING_ASSISTANT_HIDDEN_FAST_SYNC_MS = 30 * 1000;
const JOB_FAST_SYNC_THROTTLE_MS = 30 * 1000;
const FOREGROUND_SYNC_SETTLE_MS = 3000;
const CHATGPT_URL = "https://chatgpt.com/";
const TAB_LOAD_TIMEOUT_MS = 25 * 1000;
const TAB_SETTLE_MS = 2000;
const MAX_JOB_RECOVERY_ATTEMPTS = 2;
const MAX_SCRIPT_FINAL_CONTINUES = 3;
const MAX_SCRIPT_EXPECTED_SECTIONS = 300;
const MAX_IMAGE_PROMPT_REPAIR_ATTEMPTS = 2;
const MAX_LOGS = 100;
const MIN_CHROME_ALARM_DELAY_SECONDS = 30;
const WEB_APP_TIMEOUT_MS = 25 * 1000;
const WEB_APP_MAX_ATTEMPTS = 3;
const WEB_APP_RETRY_BASE_MS = 1500;
const IMAGE_PROMPT_RECHECK_DELAY_MS = 4000;
const IMAGE_PROMPT_RECHECK_ATTEMPTS = 3;

const DEFAULT_STATE = {
  status: "idle", // idle | running | paused | completed
  delay: 5,
  logs: [],
  targetTabId: null,

  sheetConnected: false,
  webAppUrl: "",
  channels: [],
  channelStats: [],
  promptStatus: {},
  topicCount: 0,
  lastSheetCheckAt: null,
  selectedChannel: "",
  sheetWorkflowState: "GET_TOPIC",
  currentRow: null,
  currentChannel: "",
  currentTopic: "",
  scriptSheetName: "",
  config: {},
  sheetParagraphs: [],
  sheetParagraphIndex: 0,
  scriptOutline: "",
  scriptSections: [],
  scriptSectionNumbers: [],
  scriptSectionIndex: 0,
  scriptExpectedSections: 0,
  scriptLastDiversitySection: 0,
  scriptFinalContinueAttempts: 0,
  scriptFirstContinueSent: false,
  tempImagePrompts: [],
  skipImagePrompts: false,
  currentImagePromptDraft: "",
  imagePromptRepairAttempts: 0,
  sheetProgressText: "",
  sheetProgressPercent: 0,
  runLimitTopics: 0,
  completedTopicsThisRun: 0,
  txtExportFolderUrl: "",

  activeJobId: null,
  activeJobStage: null,
  activeJobStartedAt: null,
  activeJobPromptText: "",
  activeJobLastProgressAt: null,
  activeJobLastHeartbeatAt: null,
  activeJobLastSyncAt: null,
  activeJobLastProgressEvent: "",
  activeJobLastTextLength: 0,
  activeJobLastForegroundAt: null,
  activeJobTabHidden: false,
  activeJobVisibilityState: "",
  activeJobParagraphIndex: null,
  activeJobSectionIndex: null,
  jobRecoveryAttempts: 0,
  currentRunId: null,
  nextWorkflowRunAt: null
};

let workflowRunning = false;
let workflowRequested = false;
let jobWatchdogRunning = false;
let shortDelayTimerId = null;
let logWriteQueue = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(null, (existing) => {
    const nextState = { ...DEFAULT_STATE, ...existing };
    nextState.status = existing.status === "running" ? "paused" : (existing.status || "idle");
    nextState.activeJobId = null;
    nextState.activeJobStage = null;
    nextState.activeJobStartedAt = null;
    nextState.logs = existing.logs && existing.logs.length
      ? existing.logs
      : [{ text: "Da cai dat extension thanh cong.", type: "success", time: new Date().toLocaleTimeString() }];

    chrome.storage.local.set(nextState, () => {
      ensureBaseAlarms();
      fetchSelectors().catch(() => {});
    });
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureBaseAlarms();
  fetchSelectors().catch(() => {});
  resumeRunningWorkflowAfterWake("startup").catch((error) => {
    addLog(`Startup resume error: ${error.message}`, "system");
  });
});

function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => resolve(data));
  });
}

function setStorage(patch) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(patch, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function ensureBaseAlarms() {
  chrome.alarms.create(ALARM_SYNC_SELECTORS, { periodInMinutes: 30 });
  chrome.alarms.create(ALARM_WORKFLOW_HEARTBEAT, {
    periodInMinutes: WORKFLOW_HEARTBEAT_PERIOD_MINUTES
  });
}

async function clearWorkflowAlarms() {
  clearShortDelayTimer();
  await Promise.all([
    clearAlarm(ALARM_NEXT_PROMPT),
    clearAlarm(ALARM_JOB_TIMEOUT),
    clearAlarm(ALARM_JOB_WATCHDOG),
    clearAlarm("retryAlarm")
  ]);
}

function clearAlarm(name) {
  return new Promise((resolve) => {
    chrome.alarms.clear(name, resolve);
  });
}

function scheduleJobTimeoutAlarm() {
  chrome.alarms.clear(ALARM_JOB_TIMEOUT, () => {
    chrome.alarms.create(ALARM_JOB_TIMEOUT, { delayInMinutes: RESPONSE_TIMEOUT_MS / 60000 });
  });
}

function scheduleJobWatchdogAlarm() {
  chrome.alarms.clear(ALARM_JOB_WATCHDOG, () => {
    chrome.alarms.create(ALARM_JOB_WATCHDOG, {
      delayInMinutes: JOB_WATCHDOG_PERIOD_MINUTES,
      periodInMinutes: JOB_WATCHDOG_PERIOD_MINUTES
    });
  });
}

function scheduleJobWatchdogCheckAfterSeconds(seconds) {
  const safeSeconds = Math.max(MIN_CHROME_ALARM_DELAY_SECONDS, Number(seconds) || MIN_CHROME_ALARM_DELAY_SECONDS);
  chrome.alarms.clear(ALARM_JOB_WATCHDOG, () => {
    chrome.alarms.create(ALARM_JOB_WATCHDOG, {
      delayInMinutes: safeSeconds / 60,
      periodInMinutes: JOB_WATCHDOG_PERIOD_MINUTES
    });
  });
}

async function clearActiveJobAlarms() {
  await clearAlarm(ALARM_JOB_TIMEOUT);
  await clearAlarm(ALARM_JOB_WATCHDOG);
}

function clearShortDelayTimer() {
  if (shortDelayTimerId !== null) {
    clearTimeout(shortDelayTimerId);
    shortDelayTimerId = null;
  }
}

function scheduleAlarmAfterSeconds(seconds) {
  chrome.alarms.clear(ALARM_NEXT_PROMPT, () => {
    chrome.alarms.create(ALARM_NEXT_PROMPT, { delayInMinutes: seconds / 60 });
  });
}

function scheduleWorkflowRunAfterSeconds(seconds) {
  const delaySeconds = Math.max(0, Number(seconds) || 0);
  clearShortDelayTimer();

  if (delaySeconds <= 0) {
    chrome.alarms.clear(ALARM_NEXT_PROMPT);
    requestWorkflowRun();
    return;
  }

  setStorage({ nextWorkflowRunAt: Date.now() + (delaySeconds * 1000) }).catch(() => {});

  if (delaySeconds < MIN_CHROME_ALARM_DELAY_SECONDS) {
    shortDelayTimerId = setTimeout(() => {
      shortDelayTimerId = null;
      chrome.alarms.clear(ALARM_NEXT_PROMPT);
      requestWorkflowRun();
    }, delaySeconds * 1000);

    scheduleAlarmAfterSeconds(MIN_CHROME_ALARM_DELAY_SECONDS);
    return;
  }

  scheduleAlarmAfterSeconds(delaySeconds);
}

function addLog(text, type = "normal") {
  const entry = { text, type, time: new Date().toLocaleTimeString() };
  logWriteQueue = logWriteQueue
    .catch(() => {})
    .then(() => writeLogEntry(entry));
  return logWriteQueue;
}

async function writeLogEntry(entry) {
  const data = await getStorage({ logs: [] });
  const logs = data.logs || [];
  logs.push(entry);
  while (logs.length > MAX_LOGS) logs.shift();
  await setStorage({ logs });
}

function createJobId(stage) {
  return `${Date.now()}-${stage}-${createRandomId()}`;
}

function createRandomId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  const now = globalThis.performance && typeof globalThis.performance.now === "function"
    ? globalThis.performance.now()
    : 0;
  return `${Date.now()}-${Math.floor(now * 1000)}`;
}

function shortText(value, length = 35) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function isChatGPTTab(tab) {
  try {
    const url = new URL(tab && tab.url ? tab.url : "");
    return url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
}

function detectExpectedSections(promptText) {
  if (AutoPilotLib && typeof AutoPilotLib.detectExpectedSectionCount === "function") {
    return AutoPilotLib.detectExpectedSectionCount(promptText, MAX_SCRIPT_EXPECTED_SECTIONS);
  }

  const normalized = normalizeCommandText(promptText);
  const match = normalized.match(/\b(\d{1,3})\s+(?:chuong|chapter|chapters|section|sections|phan|part|parts|doan)\b/);
  const expected = match ? Number(match[1]) : 0;
  return Number.isFinite(expected) && expected > 0 && expected <= MAX_SCRIPT_EXPECTED_SECTIONS
    ? expected
    : 0;
}

function detectScriptOutlineSectionCount(outlineText) {
  if (AutoPilotLib && typeof AutoPilotLib.detectNumberedOutlineCount === "function") {
    return AutoPilotLib.detectNumberedOutlineCount(outlineText, MAX_SCRIPT_EXPECTED_SECTIONS);
  }

  return 0;
}

function usesContinueWorkflow(promptText) {
  return detectExpectedSections(promptText) > 1;
}

function getExpectedSectionCountForSave(state, sections) {
  const explicit = Number(state && state.scriptExpectedSections);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }

  const sectionCount = Array.isArray(sections) ? sections.length : 0;
  return sectionCount > 0 ? sectionCount : 0;
}

function isFinalScriptResponse(text) {
  return AutoPilotLib.isFinalScriptResponseText(text);
}

function getPromptPlaceholderValues(state, overrides = {}) {
  const topic = overrides.topic !== undefined
    ? overrides.topic
    : (state && state.currentTopic);
  const channel = overrides.channel !== undefined
    ? overrides.channel
    : (state && (state.currentChannel || state.selectedChannel));
  const text = overrides.text !== undefined ? overrides.text : "";

  return {
    topic: String(topic || ""),
    channel: String(channel || "").trim(),
    text: String(text || "")
  };
}

function applyPromptPlaceholders(template, state = {}, overrides = {}) {
  const values = getPromptPlaceholderValues(state, overrides);
  const replacements = {
    TOPIC: values.topic,
    CHANNEL: values.channel,
    KENH: values.channel,
    TEXT: values.text
  };

  return String(template || "").replace(/\{(TOPIC|CHANNEL|KENH|TEXT)\}/gi, (match, key) => {
    return replacements[key.toUpperCase()] || "";
  });
}

function getScriptContinuePrompt(state) {
  const prompt = (state.config && state.config.scriptContinuePrompt) ||
    'CONTINUE do not use "—"';
  return applyPromptPlaceholders(prompt, state);
}

function getScriptFinalContinuePrompt(state) {
  if (promptUsesLiteralContinue(state)) {
    return [
      "CONTINUE",
      "",
      "Viet phan ket thuc cau chuyen ngay bay gio.",
      "Khong hoi them CONTINUE.",
      "Ket thuc truyen ro rang."
    ].join("\n");
  }

  const prompt = (state.config && state.config.scriptFinalContinuePrompt) ||
    'CONTINUE with the final wind-down and ending now. Do not ask for another CONTINUE. End the story with exactly: End of script. Sweet dreams.';
  return applyPromptPlaceholders(prompt, state);
}

function promptUsesLiteralContinue(state) {
  return /\bCONTINUE\b/i.test(String(state && state.promptND || ""));
}

function getScriptDiversityEvery(state) {
  const value = Number(state.config && state.config.scriptDiversityEvery);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

function getScriptDiversityPrompt(state) {
  const prompt = (state.config && state.config.scriptDiversityPrompt) ||
    (isVietnameseWorkflow(state)
      ? "Từ các chương tiếp theo, hãy đa dạng cách dẫn chuyện, cách mở bí mật và cách tạo căng thẳng. Không lặp lại cùng một kiểu câu hoặc cùng một công thức chuyển cảnh quá nhiều lần. Vẫn giữ đúng chủ đề hôn nhân gia đình, ADN, con ruột, phản bội, sự thật bị che giấu và báo ứng. Chỉ trả lời: Đã hiểu."
      : "From the next sections onward, vary the phrasing, transitions, reveals, and tension beats. Do not repeat the same sentence pattern or scene-opening formula too often. Keep the story on its current topic and only reply: Understood.");
  return applyPromptPlaceholders(prompt, state);
}

function isVietnameseWorkflow(state) {
  const text = String(state && state.promptND || "");
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text)) {
    return true;
  }

  const normalized = normalizeCommandText(text);
  return /\b(chuong|truyen|viet tiep|tiep tuc|cho lenh|hon nhan|gia dinh)\b/.test(normalized);
}

function buildImagePromptForParagraph(state, paragraphIdx) {
  const paragraphs = state.sheetParagraphs || [];
  const currentParagraph = paragraphs[paragraphIdx] || "";
  const promptAnhTemplate = String(state.promptAnh || "").trim();
  if (!promptAnhTemplate) return "";

  const finalTemplate = applyPromptPlaceholders(promptAnhTemplate, state, { text: currentParagraph });
  return imagePromptTemplateHasTextPlaceholder(promptAnhTemplate)
    ? finalTemplate
    : `${finalTemplate}\n\n${currentParagraph}`;
}

function hasImagePromptTemplate(state) {
  const promptText = String(state && state.promptAnh || "").trim();
  if (!promptText) return false;

  const promptStatus = state && state.promptStatus ? state.promptStatus : {};
  if (promptStatus.hasPromptAnh === false) return false;

  return true;
}

function imagePromptTemplateHasTextPlaceholder(template) {
  return /\{TEXT\}/i.test(String(template || ""));
}

function getExpectedImagePromptsPerSection(state) {
  const configured = Number(state.config && state.config.imagePromptsPerSection);
  if (Number.isFinite(configured) && configured > 0 && configured <= 20) return configured;

  const promptText = String(state.promptAnh || "");
  const patterns = [
    /exactly\s+(\d{1,2})\s+(?:image\s+)?prompts?/i,
    /(\d{1,2})\s+(?:image\s+)?prompts?/i,
    /(\d{1,2})\s+prompt\s+(?:anh|image)/i
  ];

  for (const pattern of patterns) {
    const match = promptText.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value <= 20) return value;
    }
  }

  return 5;
}

function countImagePromptsInResponse(responseText) {
  return splitImagePromptResponseBlocks(responseText).length;
}

function splitImagePromptResponseBlocks(responseText) {
  const text = String(responseText || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return [];

  const sectionBlocks = splitImagePromptSectionNumberedBlocks(text);
  if (sectionBlocks.length >= 2) return sectionBlocks;

  const labelledBlocks = splitImagePromptLabelledBlocks(text);
  if (labelledBlocks.length >= 2) return labelledBlocks;

  const listBlocks = splitImagePromptListBlocks(text);
  if (listBlocks.length >= 2) return listBlocks;

  const inlineBlocks = splitInlineNumberedImagePrompts(text);
  if (inlineBlocks.length >= 2) return inlineBlocks;

  const paragraphBlocks = mergeImagePromptTitleBlocksForCount(text
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean));
  if (paragraphBlocks.length >= 2 && paragraphBlocks.length <= 20) return paragraphBlocks;

  return text ? [text] : [];
}

function splitImagePromptSectionNumberedBlocks(text) {
  const lines = String(text || "").split("\n");
  const markerPattern = /^\s*\d{1,3}\.\d{1,2}\s*(?:[:.\-\u2013\u2014\)]\s*)?/;
  const markerCount = lines.filter((line) => markerPattern.test(line)).length;
  if (markerCount < 2 || markerCount > 20) return [];

  const blocks = [];
  let current = null;
  lines.forEach((line) => {
    if (markerPattern.test(line)) {
      if (current && current.join("").trim()) blocks.push(current.join("\n").trim());
      current = [line.replace(markerPattern, "").trim()];
      return;
    }

    if (current) current.push(line);
  });

  if (current && current.join("").trim()) blocks.push(current.join("\n").trim());
  return mergeImagePromptTitleBlocksForCount(blocks);
}

function splitImagePromptLabelledBlocks(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let current = null;

  lines.forEach((line) => {
    if (isImagePromptLabelLine(line)) {
      if (current && current.join("").trim()) blocks.push(current.join("\n").trim());
      current = [];
      const remainder = stripImagePromptLabel(line);
      if (remainder) current.push(remainder);
      return;
    }

    if (current) current.push(line);
  });

  if (current && current.join("").trim()) blocks.push(current.join("\n").trim());
  return mergeImagePromptTitleBlocksForCount(blocks);
}

function splitImagePromptListBlocks(text) {
  const lines = String(text || "").split("\n");
  const markerPattern = /^\s*(?:\d+(?:[\.\)]|\s+)|[-*]\s+)(?!\*)/;
  const markerCount = lines.filter((line) => markerPattern.test(line)).length;
  if (markerCount < 2 || markerCount > 20) return [];

  const blocks = [];
  let current = null;
  lines.forEach((line) => {
    if (markerPattern.test(line)) {
      if (current && current.join("").trim()) blocks.push(current.join("\n").trim());
      current = [line.replace(markerPattern, "").trim()];
      return;
    }

    if (current) current.push(line);
  });

  if (current && current.join("").trim()) blocks.push(current.join("\n").trim());
  return mergeImagePromptTitleBlocksForCount(blocks);
}

function splitInlineNumberedImagePrompts(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const markerPattern = /(?:^|\s)(?:prompt\s*)?#?\d{1,2}[\.\):]\s+/gi;
  const matches = Array.from(normalized.matchAll(markerPattern));
  if (matches.length < 2 || matches.length > 20) return [];

  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : normalized.length;
    return normalized.slice(start, end).trim();
  }).filter(Boolean);
}

function isImagePromptLabelLine(line) {
  const normalized = normalizeCommandText(line);
  return /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*((image\s+)?prompt|prompt\s+anh)\s*#?\s*\d+\s*(?:[:.\-\)]|\*\*|$)/i.test(normalized);
}

function stripImagePromptLabel(line) {
  return String(line || "")
    .replace(/^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*((image\s+)?prompt|prompt\s+(anh|ảnh))\s*#?\s*\d+\s*(?:[:.\-\)]|\*\*)?\s*/i, "")
    .replace(/^\s*\*\*/, "")
    .replace(/\*\*\s*$/, "")
    .trim();
}

function mergeImagePromptTitleBlocksForCount(blocks) {
  const merged = [];
  for (let i = 0; i < blocks.length; i++) {
    const current = String(blocks[i] || "").trim();
    const next = String(blocks[i + 1] || "").trim();

    if (next && isLikelyImagePromptTitleForCount(current, next)) {
      merged.push(`${current}\n${next}`);
      i++;
    } else if (!isLikelyImagePromptTitleOnlyForCount(current)) {
      merged.push(current);
    }
  }
  return merged.filter(Boolean);
}

function isGeneratedImagePromptHeadingForCount(text) {
  const normalized = normalizeCommandText(String(text || "")
    .replace(/\*\*/g, "")
    .replace(/^\s*(?:#{1,6}\s*)?/, "")
    .replace(/^\s*[-*\u2013\u2014]\s*/, "")
    .trim());

  if (!normalized || normalized.length > 180) return false;
  return /\b(?:prompts?|prompt\s+(?:anh|image))\s*:$/.test(normalized);
}

function isLikelyImagePromptTitleOnlyForCount(text) {
  const cleaned = String(text || "")
    .replace(/^\s*[-\u2013\u2014]\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
  if (!cleaned) return true;
  if (isGeneratedImagePromptHeadingForCount(cleaned)) return true;
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  return cleaned.length <= 90 &&
    wordCount > 0 &&
    wordCount <= 14 &&
    cleaned.indexOf(",") === -1 &&
    !/[.;:]$/.test(cleaned);
}

function isLikelyImagePromptTitleForCount(title, nextText) {
  const cleanTitle = String(title || "").replace(/^\s*[-\u2013\u2014]\s*/, "").replace(/\*\*/g, "").trim();
  const cleanNext = String(nextText || "").trim();
  const wordCount = cleanTitle ? cleanTitle.split(/\s+/).length : 0;

  return cleanTitle.length <= 90 &&
    wordCount > 0 &&
    wordCount <= 14 &&
    cleanNext.length >= 80 &&
    cleanNext.indexOf(",") !== -1 &&
    !/[\,\.;:]$/.test(cleanTitle);
}

function buildImagePromptRepairPrompt(expectedCount, currentCount) {
  const missingCount = Math.max(1, expectedCount - currentCount);
  const startNumber = currentCount + 1;
  const endNumber = expectedCount;

  return [
    `You only provided ${currentCount}/${expectedCount} image prompts for this section.`,
    `Write exactly the missing ${missingCount} image prompts now, numbered ${startNumber} to ${endNumber}.`,
    "Do not repeat previous prompts.",
    "Do not add explanations, headings, or extra text.",
    "Each prompt must be a complete standalone image prompt."
  ].join("\n");
}

function findAssistantResponseForPrompt(history, promptText, options = {}) {
  return AutoPilotLib.findAssistantResponseForPromptHistory(history, promptText, options);
}

async function syncLatestAssistantResponseDetails(state, promptText, options = {}) {
  let tabId = state.targetTabId;
  if (!tabId) {
    const tab = await findChatGPTTab();
    if (tab) {
      tabId = tab.id;
      await setStorage({ targetTabId: tabId });
    }
  }

  if (!tabId) {
    return {
      response: "",
      generating: false,
      hidden: false,
      visibilityState: "",
      latestTextLength: 0
    };
  }

  const response = await sendMessageToTab(tabId, { action: "SYNC_CHAT_HISTORY" });
  if (!response || !response.success || !Array.isArray(response.history)) {
    return {
      response: "",
      generating: false,
      hidden: false,
      visibilityState: "",
      latestTextLength: 0
    };
  }

  const latestHistoryItem = response.history[response.history.length - 1] || {};
  const latestTextLength = String(latestHistoryItem.response || "").trim().length;
  const matchedHistoryItem = [...response.history].reverse().find((item) =>
    AutoPilotLib.promptMatchesTrackedJob(item && item.prompt, promptText)
  ) || {};

  return {
    response: findAssistantResponseForPrompt(response.history, promptText, options),
    outlineSectionCount: Number(matchedHistoryItem.outlineSectionCount) || 0,
    generating: Boolean(response.generating),
    hidden: Boolean(response.hidden),
    visibilityState: response.visibilityState || "",
    latestTextLength
  };
}

async function syncLatestAssistantResponse(state, promptText) {
  const details = await syncLatestAssistantResponseDetails(state, promptText);
  return details.response;
}

async function recheckImagePromptResponse(state, paragraphIdx, expectedCount, responseText) {
  const promptText = state.activeJobStage === "image_prompt_repair"
    ? buildImagePromptRepairPrompt(
        expectedCount,
        countImagePromptsInResponse(state.currentImagePromptDraft || "")
      )
    : buildImagePromptForParagraph(state, paragraphIdx);
  const draftPrefix = state.activeJobStage === "image_prompt_repair"
    ? String(state.currentImagePromptDraft || "").trim()
    : "";
  let bestResponse = String(responseText || "").trim();
  let bestCount = countImagePromptsInResponse(bestResponse);

  for (let attempt = 1; attempt <= IMAGE_PROMPT_RECHECK_ATTEMPTS && bestCount < expectedCount; attempt++) {
    await sleep(IMAGE_PROMPT_RECHECK_DELAY_MS);

    try {
      const syncedResponse = await syncLatestAssistantResponse(state, promptText);
      if (!syncedResponse) continue;

      const candidateResponse = draftPrefix
        ? `${draftPrefix}\n\n${syncedResponse}`.trim()
        : syncedResponse;
      const candidateCount = countImagePromptsInResponse(candidateResponse);
      if (candidateCount > bestCount || (candidateCount === bestCount && candidateResponse.length > bestResponse.length)) {
        bestResponse = candidateResponse;
        bestCount = candidateCount;
      }
    } catch (error) {
      await addLog(`Khong dong bo duoc response prompt anh de kiem tra lai: ${error.message}`, "warning");
      break;
    }
  }

  return {
    response: bestResponse,
    count: bestCount
  };
}

function isRetryableWebAppHttpStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isRetryableWebAppError(error) {
  if (!error) return false;
  if (error.httpStatus) return isRetryableWebAppHttpStatus(error.httpStatus);
  if (error.name === "AbortError") return true;

  const message = String(error.message || "").toLowerCase();
  return message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("could not acquire spreadsheet lock") ||
    message.includes("service invoked too many") ||
    message.includes("quota");
}

function getWebAppRetryDelayMs(attempt) {
  return Math.min(10000, WEB_APP_RETRY_BASE_MS * Math.pow(2, attempt - 1));
}

function normalizeCommandText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isScriptContinuePrompt(promptText, state = {}) {
  if (hasTrackedContinueMarker(promptText)) return true;

  const normalized = normalizeCommandText(stripTrackedPromptMarker(promptText));
  const configuredPrompts = [
    getScriptContinuePrompt(state),
    getScriptFinalContinuePrompt(state)
  ].map(normalizeCommandText).filter(Boolean);

  if (configuredPrompts.includes(normalized)) return true;
  return /^(continue|please continue|tiep tuc|vui long tiep tuc|viet tiep|hay tiep tuc)\b/.test(normalized);
}

function isScriptGuidancePrompt(promptText, state) {
  const normalized = normalizeCommandText(stripTrackedPromptMarker(promptText));
  const diversityPrompt = normalizeCommandText(getScriptDiversityPrompt(state));

  if (diversityPrompt && normalized === diversityPrompt) return true;
  return /\b(diverse|diversity|repeat|lap lai|da dang|dien dat)\b/.test(normalized);
}

function hasTrackedContinueMarker(promptText) {
  return /\[AUTO_PILOT_(?:SECTION|CHUONG|FINAL_CONTINUE|KET_THUC)\b/i.test(String(promptText || ""));
}

function stripTrackedPromptMarker(promptText) {
  return String(promptText || "")
    .replace(/^\s*\[AUTO_PILOT_(?:SECTION|CHUONG)\s+\d{1,3}(?:\s*\/\s*(?:\d{1,3}|\?))?\]\s*/i, "")
    .replace(/^\s*\[AUTO_PILOT_(?:FINAL_CONTINUE|KET_THUC)\s+(?:after|sau)\s+(?:\d{1,3}|last|cuoi)\]\s*/i, "");
}

function responseRequestsContinuation(text) {
  const normalized = normalizeCommandText(text);

  const patterns = [
    /\bawaiting\s+["'\u201c\u201d]?continue["'\u201c\u201d]?/i,
    /\bwaiting\s+for\s+["'\u201c\u201d]?continue["'\u201c\u201d]?/i,
    /\b(?:send|type|say|enter|reply(?:\s+with)?)\s+["'\u201c\u201d]?continue["'\u201c\u201d]?/i,
    /\bcontinue\b.{0,100}\b(?:final|ending|conclusion|wind[-\s]?down|wrap[-\s]?up|last)\b/i,
    /\b(?:final|ending|conclusion|wind[-\s]?down|wrap[-\s]?up|last)\b.{0,100}\bcontinue\b/i,
    /\b(?:hay|vui long|xin|go|nhap|gui|tra loi|phan hoi)\b.{0,80}\b(?:continue|tiep tuc|viet tiep)\b/i,
    /\b(?:continue|tiep tuc|viet tiep)\b.{0,80}\b(?:phan ket|ket thuc|doan cuoi|phan cuoi)\b/i,
    /\b(?:phan ket|ket thuc|doan cuoi|phan cuoi)\b.{0,80}\b(?:continue|tiep tuc|viet tiep)\b/i,
    /\b(?:awaiting|waiting|ready|standing by)\b.{0,120}\b(?:request|instruction|prompt)\b.{0,120}\b(?:final|ending|conclusion|wind[-\s]?down|wrap[-\s]?up|last)\b/i,
    /\b(?:awaiting|waiting|ready|standing by)\b.{0,120}\b(?:final|ending|conclusion|wind[-\s]?down|wrap[-\s]?up|last)\b/i,
    /\b(?:request|instruction|prompt)\b.{0,120}\b(?:final|ending|conclusion|wind[-\s]?down|wrap[-\s]?up|last)\b/i,
    /\b(?:final|ending|conclusion|wind[-\s]?down|wrap[-\s]?up|last)\b.{0,120}\b(?:request|instruction|prompt)\b/i,
    /\b(?:dang cho|cho|san sang)\b.{0,120}\b(?:yeu cau|lenh|prompt|phan ket|ket thuc|doan cuoi|phan cuoi)\b/i,
    /\b(?:yeu cau|lenh|prompt)\b.{0,120}\b(?:phan ket|ket thuc|doan cuoi|phan cuoi)\b/i
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function extractScriptSectionNumber(text) {
  return AutoPilotLib.extractLeadingScriptSectionNumber(text);
}

function extractTrackedPromptSectionNumber(promptText) {
  const text = String(promptText || "");
  const markerMatch = text.match(/\[AUTO_PILOT_(?:SECTION|CHUONG)\s+(\d{1,3})(?:\s*\/\s*(?:\d{1,3}|\?))?\]/i);
  if (markerMatch) return Number(markerMatch[1]) || 0;

  const finalMarkerMatch = text.match(/\[AUTO_PILOT_(?:FINAL_CONTINUE|KET_THUC)\s+(?:after|sau)\s+(\d{1,3}|last|cuoi)\]/i);
  if (finalMarkerMatch && finalMarkerMatch[1] !== "last" && finalMarkerMatch[1] !== "cuoi") {
    const afterSection = Number(finalMarkerMatch[1]);
    return Number.isFinite(afterSection) && afterSection > 0 && afterSection < 300
      ? afterSection + 1
      : 0;
  }

  const normalized = normalizeCommandText(text);
  const writingMatch = normalized.match(/\b(?:writing|write|viet)\s+(?:section|chapter|chuong|phan|doan)\s+(\d{1,3})\b/);
  return writingMatch ? (Number(writingMatch[1]) || 0) : 0;
}

function buildTrackedSectionPrompt(basePrompt, sectionIndex, expectedSections, state = {}) {
  const total = expectedSections || "?";
  return [
    `[AUTO_PILOT_SECTION ${sectionIndex}/${total}]`,
    basePrompt,
    "",
    `You are writing Section ${sectionIndex}${expectedSections ? ` of ${expectedSections}` : ""}.`,
    `Start your next answer with exactly: Section ${sectionIndex}`,
    "Do not skip, merge, or renumber sections."
  ].join("\n");
}

function buildTrackedFinalPrompt(basePrompt, expectedSections, state = {}) {
  return [
    `[AUTO_PILOT_FINAL_CONTINUE after ${expectedSections || "last"}]`,
    basePrompt,
    "",
    "Write only the requested final wind-down or ending.",
    "Do not start a new numbered section unless the story naturally requires that label."
  ].join("\n");
}

function deriveScriptSectionNumbers(sections) {
  return (sections || []).map((section, index) => extractScriptSectionNumber(section) || (index + 1));
}

function mergeScriptSectionItems(currentSections, currentNumbers, newItems) {
  const sectionMap = new Map();
  const numbers = currentNumbers && currentNumbers.length
    ? currentNumbers
    : deriveScriptSectionNumbers(currentSections);

  (currentSections || []).forEach((section, index) => {
    const number = Number(numbers[index]) || extractScriptSectionNumber(section) || (index + 1);
    if (number > 0 && !sectionMap.has(number)) {
      sectionMap.set(number, section);
    }
  });

  (newItems || []).forEach((item) => {
    const number = Number(item.number) || 0;
    const response = String(item.response || "").trim();
    if (number > 0 && response) {
      sectionMap.set(number, pickBetterScriptSection(sectionMap.get(number), response));
    }
  });

  const sortedNumbers = Array.from(sectionMap.keys()).sort((a, b) => a - b);
  return {
    sections: sortedNumbers.map((number) => sectionMap.get(number)),
    numbers: sortedNumbers
  };
}

function pickBetterScriptSection(current, candidate) {
  const currentText = String(current || "").trim();
  const candidateText = String(candidate || "").trim();
  if (!candidateText) return currentText;
  if (!currentText) return candidateText;

  const currentNormalized = normalizeScriptSectionForCompare(currentText);
  const candidateNormalized = normalizeScriptSectionForCompare(candidateText);
  if (candidateNormalized === currentNormalized) return currentText;

  if (looksLikeTruncatedSection(currentText) && candidateNormalized.length > currentNormalized.length) {
    return candidateText;
  }

  if (candidateNormalized.length >= currentNormalized.length + 80) {
    return candidateText;
  }

  return currentText;
}

function normalizeScriptSectionForCompare(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeTruncatedSection(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return true;

  const stripped = cleaned.replace(/[*_`~]/g, "").trim();
  if (/awaiting\s+["'\u201c\u201d]?continue["'\u201c\u201d]?/i.test(stripped)) return false;
  if (/end of script\.\s*sweet dreams\.?$/i.test(stripped)) return false;

  const tail = stripped.slice(-100).trim();
  return Boolean(tail && !/[\.\?!:;\)"'\]\u201d\u2019]$/.test(tail));
}

function countChangedScriptSections(currentSections, mergedSections) {
  let changed = 0;
  const total = Math.max(currentSections.length, mergedSections.length);
  for (let i = 0; i < total; i++) {
    if (normalizeScriptSectionForCompare(currentSections[i]) !== normalizeScriptSectionForCompare(mergedSections[i])) {
      changed++;
    }
  }
  return changed;
}

function findMissingScriptSections(sectionNumbers, expectedSections) {
  if (!expectedSections) return [];

  const existing = new Set((sectionNumbers || []).filter((number) => number > 0 && number <= expectedSections));
  const missing = [];
  for (let number = 1; number <= expectedSections; number++) {
    if (!existing.has(number)) missing.push(number);
  }
  return missing;
}

async function callWebApp(params, payload = null) {
  const data = await getStorage(["webAppUrl", "webAppToken"]);
  const splitUrl = AutoPilotLib.splitWebAppUrlAndToken(data.webAppUrl || "");
  const webAppUrl = splitUrl.url;
  const webAppToken = data.webAppToken || splitUrl.token || "";

  if (!webAppUrl) {
    throw new Error("Chua cau hinh Google Apps Script Web App URL.");
  }

  if (splitUrl.url !== data.webAppUrl) {
    setStorage({ webAppUrl }).catch(() => {});
  }

  const requestBody = payload
    ? { ...payload }
    : { ...(params || {}) };

  if (webAppToken) {
    requestBody.token = webAppToken;
  }

  const url = webAppUrl;
  const maskedUrl = AutoPilotLib.maskSecretsInUrl(url);
  await addLog(`Gửi request Web App (POST): ${maskedUrl}`, "normal");

  const options = {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(requestBody)
  };

  let lastError = null;
  for (let attempt = 1; attempt <= WEB_APP_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEB_APP_TIMEOUT_MS);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = new Error(`Web App HTTP ${response.status}`);
        error.httpStatus = response.status;
        throw error;
      }

      const json = await response.json();
      if (json && json.error) {
        throw new Error(json.error);
      }
      return json;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;

      if (!isRetryableWebAppError(error) || attempt >= WEB_APP_MAX_ATTEMPTS) {
        throw error;
      }

      const delayMs = getWebAppRetryDelayMs(attempt);
      await addLog(`Web App loi tam thoi (${attempt}/${WEB_APP_MAX_ATTEMPTS}): ${error.message}. Retry sau ${Math.round(delayMs / 1000)}s.`, "warning");
      await sleep(delayMs);
    }
  }

  throw lastError || new Error("Web App request failed");
}

async function refreshConfigFromWebApp() {
  const config = await callWebApp({ action: "getConfig" });
  
  // Extract and parse dynamic selectors from sheet config if present
  let selectors = null;
  if (config && config.selectors) {
    selectors = config.selectors;
  } else if (config && config.config) {
    selectors = extractSelectorsFromConfigObj(config.config);
  }
  
  const storagePatch = {
    promptND: config.promptND || "",
    promptAnh: config.promptAnh || "",
    config: config.config || {},
    channels: config.channels || [],
    channelStats: config.channelStats || [],
    promptStatus: config.promptStatus || {},
    topicCount: config.topicCount || 0,
    lastSheetCheckAt: Date.now(),
    sheetConnected: true
  };
  
  if (selectors) {
    storagePatch.selectorsCached = selectors;
    storagePatch.lastSelectorsFetch = Date.now();
  }
  
  await setStorage(storagePatch);
  return config;
}

async function fetchSelectors() {
  try {
    const config = await refreshConfigFromWebApp();
    const data = await getStorage(["selectorsCached"]);
    if (data.selectorsCached) {
      await addLog("Da dong bo remote selectors tu Google Sheet.", "success");
      return data.selectorsCached;
    }
  } catch (error) {
    // Silently log and use cached selectors if any
  }
  const data = await getStorage(["selectorsCached"]);
  return data.selectorsCached || null;
}

function parseSelectorValue(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(s => s.trim()).filter(Boolean);
    } catch (e) {
      // ignore JSON parse error
    }
  }
  return trimmed.split(",").map(s => s.trim()).filter(Boolean);
}

function extractSelectorsFromConfigObj(configObj) {
  const selectors = {};
  if (configObj.composerSelectors) {
    selectors.composerSelectors = parseSelectorValue(configObj.composerSelectors);
  }
  if (configObj.sendButtonSelectors) {
    selectors.sendButtonSelectors = parseSelectorValue(configObj.sendButtonSelectors);
  }
  if (configObj.scopedStreamingSelectors) {
    selectors.scopedStreamingSelectors = parseSelectorValue(configObj.scopedStreamingSelectors);
  }
  if (configObj.pageStreamingSelectors) {
    selectors.pageStreamingSelectors = parseSelectorValue(configObj.pageStreamingSelectors);
  }
  if (configObj.stopButtonSelectors) {
    selectors.stopButtonSelectors = parseSelectorValue(configObj.stopButtonSelectors);
  }
  if (configObj.assistantMessageSelectors) {
    selectors.assistantMessageSelectors = parseSelectorValue(configObj.assistantMessageSelectors);
  }
  return Object.keys(selectors).length > 0 ? selectors : null;
}

async function updateSheetJobProgress(state, patch) {
  if (!state.selectedChannel || !state.currentTopic) return;

  try {
    await callWebApp({}, {
      action: "updateJob",
      channel: state.selectedChannel,
      row: state.currentRow,
      topic: state.currentTopic,
      runId: state.currentRunId,
      ...patch
    });
  } catch (error) {
    await addLog(`Khong cap nhat duoc checkpoint tren Sheet: ${error.message}`, "warning");
  }
}

async function markSheetJobError(state, message) {
  if (!state.selectedChannel || !state.currentTopic) return;

  try {
    await callWebApp({}, {
      action: "markError",
      channel: state.selectedChannel,
      row: state.currentRow,
      topic: state.currentTopic,
      runId: state.currentRunId,
      stage: state.sheetWorkflowState,
      message
    });
  } catch (error) {
    await addLog(`Khong ghi duoc loi len Sheet: ${error.message}`, "warning");
  }
}

async function cancelSheetJob(state) {
  if (!state.selectedChannel || !state.currentTopic) return;

  try {
    await callWebApp({}, {
      action: "cancelJob",
      channel: state.selectedChannel,
      row: state.currentRow,
      topic: state.currentTopic,
      runId: state.currentRunId,
      stage: state.sheetWorkflowState,
      message: "Stopped by user"
    });
  } catch (error) {
    await addLog(`Khong huy duoc job tren Sheet: ${error.message}`, "warning");
  }
}

async function findChatGPTTab() {
  const tabs = await chrome.tabs.query({ url: "*://chatgpt.com/*" });
  if (!tabs.length) return null;
  return tabs.find((tab) => tab.active) || tabs[0];
}

async function getChromeWindow(windowId) {
  try {
    return await chrome.windows.get(windowId);
  } catch {
    return null;
  }
}

async function focusChatGPTTab(tab) {
  if (!tab || !tab.id) return null;

  const windowBefore = tab.windowId ? await getChromeWindow(tab.windowId) : null;
  const wasNotForeground = !tab.active ||
    !windowBefore ||
    !windowBefore.focused ||
    windowBefore.state === "minimized";

  if (windowBefore && windowBefore.state === "minimized") {
    await chrome.windows.update(tab.windowId, { state: "normal" });
  }

  if (!tab.active) {
    tab = await chrome.tabs.update(tab.id, { active: true }) || tab;
  }

  if (!windowBefore || !windowBefore.focused || windowBefore.state === "minimized") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  try {
    tab = await chrome.tabs.get(tab.id);
  } catch {
    // Keep the last known tab object if Chrome cannot return a fresh one.
  }

  return { tab, wasNotForeground };
}

async function ensureTargetTabForeground(state) {
  let tab = null;

  if (state && state.targetTabId) {
    try {
      tab = await chrome.tabs.get(state.targetTabId);
      if (tab && !isChatGPTTab(tab)) tab = null;
    } catch {
      tab = null;
    }
  }

  if (!tab) tab = await findChatGPTTab();
  if (!tab) return null;

  const result = await focusChatGPTTab(tab);
  await setStorage({
    targetTabId: result.tab.id,
    activeJobLastForegroundAt: Date.now()
  });
  return result;
}

function waitForTabReady(tabId, errorMessage = "Tab ChatGPT tai qua lau.") {
  return new Promise((resolve, reject) => {
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(resolve, TAB_SETTLE_MS);
    };

    const fail = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(error);
    };

    const timeout = setTimeout(() => {
      fail(new Error(errorMessage));
    }, TAB_LOAD_TIMEOUT_MS);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        fail(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (tab && tab.status === "complete") {
        finish();
      }
    });
  });
}

function updateTabUrl(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(tab);
    });
  });
}

function createChatGPTTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: CHATGPT_URL, active: true }, async (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      try {
        await waitForTabReady(tab.id, "Khong the mo ChatGPT trong thoi gian cho.");
        const loadedTab = await chrome.tabs.get(tab.id);
        resolve(loadedTab || tab);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function reloadChatGPTTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, {}, async () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      try {
        await waitForTabReady(tabId, "ChatGPT tai lai qua lau.");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function navigateTabToNewChat(tabId) {
  await updateTabUrl(tabId, CHATGPT_URL);
  await waitForTabReady(tabId, "Khong the mo phien ChatGPT moi trong thoi gian cho.");
}

async function sendMessageToTab(tabId, message) {
  // Proactively fetch cached selectors and attach to message
  try {
    const data = await getStorage(["selectorsCached"]);
    if (data.selectorsCached) {
      message.selectors = data.selectorsCached;
    }
  } catch (e) {
    // ignore
  }

  return new Promise((resolve, reject) => {
    let done = false;
    const timeoutId = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("Timeout gửi tin nhắn tới tab ChatGPT (15s)."));
    }, 15000);

    const finish = (value, isError = false) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutId);
      if (isError) {
        reject(value);
      } else {
        resolve(value);
      }
    };

    chrome.tabs.sendMessage(tabId, message, async (response) => {
      if (done) return;
      if (!chrome.runtime.lastError) {
        finish(response);
        return;
      }

      if (!chrome.scripting) {
        finish(new Error(chrome.runtime.lastError.message), true);
        return;
      }

      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"]
        });

        if (done) return;

        chrome.tabs.sendMessage(tabId, message, (retryResponse) => {
          if (done) return;
          if (chrome.runtime.lastError) {
            finish(new Error(chrome.runtime.lastError.message), true);
          } else {
            finish(retryResponse);
          }
        });
      } catch (error) {
        finish(error, true);
      }
    });
  });
}

async function sendToChatGPT(promptText, options) {
  const data = await getStorage(["targetTabId"]);
  let tab = null;

  if (data.targetTabId) {
    try {
      tab = await chrome.tabs.get(data.targetTabId);
      if (tab && !isChatGPTTab(tab)) tab = null;
    } catch {
      tab = null;
    }
  }

  if (!tab) tab = await findChatGPTTab();
  if (!tab) {
    if (options.requiresExistingChat) {
      throw new Error("Khong co tab ChatGPT dang chua ngu canh hoi thoai cu. Khong the gui CONTINUE vao chat trong.");
    }

    await addLog("Khong co tab ChatGPT. Dang tu mo tab moi...", "normal");
    tab = await createChatGPTTab();
  }

  await setStorage({ targetTabId: tab.id });

  try {
    const focusResult = await focusChatGPTTab(tab);
    if (focusResult && focusResult.tab) {
      tab = focusResult.tab;
      await setStorage({ activeJobLastForegroundAt: Date.now() });
    }
  } catch {
    // Focusing is best-effort only.
  }

  if (options.forceNewChat) {
    await addLog("Dang mo phien ChatGPT moi...", "normal");
    await navigateTabToNewChat(tab.id);
  } else if (tab.status !== "complete") {
    await waitForTabReady(tab.id, "Tab ChatGPT chua tai xong.");
  }

  const response = await sendMessageToTab(tab.id, {
    action: "INPUT_AND_SEND",
    prompt: promptText,
    jobId: options.jobId,
    jobKind: options.jobKind || "script"
  });

  if (!response || response.status !== "started") {
    throw new Error("Content script khong xac nhan bat dau gui prompt.");
  }
}

function requestWorkflowRun() {
  workflowRequested = true;
  setStorage({ nextWorkflowRunAt: null }).catch(() => {});
  setTimeout(runWorkflow, 0);
}

async function runWorkflow() {
  if (workflowRunning) return;
  workflowRunning = true;

  try {
    while (workflowRequested) {
      workflowRequested = false;
      await runWorkflowStep();
    }
  } catch (error) {
    console.error("Workflow error:", error);
    try {
      await pauseOnError(`Loi trong qua trinh chay: ${error.message}`);
    } catch (innerError) {
      console.error("Failed to pause on error:", innerError);
    }
  } finally {
    workflowRunning = false;
  }
}

async function resumeRunningWorkflowAfterWake(reason = "heartbeat") {
  ensureBaseAlarms();

  const state = await getStorage(null);
  if (state.status !== "running") return;

  const now = Date.now();
  if (state.activeJobId) {
    scheduleJobWatchdogAlarm();
    if (reason !== "heartbeat") {
      await addLog(`Khoi phuc watchdog sau ${reason}.`, "normal");
    }
    await runJobWatchdog(false);
    return;
  }

  const nextRunAt = Number(state.nextWorkflowRunAt || 0);
  if (nextRunAt && now < nextRunAt) {
    return;
  }

  if (reason !== "heartbeat") {
    await addLog(`Khoi phuc workflow sau ${reason}.`, "normal");
  }
  requestWorkflowRun();
}

function rewindWaitingPatch(state) {
  if (state.sheetWorkflowState === "WAITING_FOR_SCRIPT") {
    return {
      sheetWorkflowState: "GENERATE_SCRIPT",
      sheetProgressText: "Da tam dung khi dang tao kich ban. San sang gui lai."
    };
  }

  if (state.sheetWorkflowState === "WAITING_FOR_SCRIPT_SECTION") {
    return {
      sheetWorkflowState: "GENERATE_SCRIPT_SECTION",
      sheetProgressText: "Da tam dung khi dang viet section. San sang gui CONTINUE lai."
    };
  }

  if (state.sheetWorkflowState === "WAITING_FOR_SCRIPT_GUIDANCE") {
    return {
      sheetWorkflowState: "GENERATE_SCRIPT_SECTION",
      sheetProgressText: "Da tam dung khi dang gui lenh dieu chinh cach dien dat."
    };
  }

  if (state.sheetWorkflowState === "WAITING_FOR_IMAGE_PROMPT") {
    return {
      sheetWorkflowState: "GENERATE_IMAGE_PROMPTS",
      sheetProgressText: "Da tam dung khi dang tao prompt anh. San sang gui lai."
    };
  }

  return {};
}

async function pauseOnError(errorMessage, extraPatch = {}) {
  const stateBeforePause = await getStorage(null);
  await clearWorkflowAlarms();
  await setStorage({
    status: "paused",
    activeJobId: null,
    activeJobStage: null,
    activeJobStartedAt: null,
    activeJobPromptText: "",
    activeJobLastProgressAt: null,
    activeJobLastHeartbeatAt: null,
    activeJobLastSyncAt: null,
    activeJobLastProgressEvent: "",
    activeJobLastTextLength: 0,
    activeJobLastForegroundAt: null,
    activeJobTabHidden: false,
    activeJobVisibilityState: "",
    activeJobParagraphIndex: null,
    activeJobSectionIndex: null,
    jobRecoveryAttempts: 0,
    nextWorkflowRunAt: null,
    ...extraPatch
  });
  await markSheetJobError(stateBeforePause, errorMessage);
  await addLog(`Loi he thong: ${errorMessage}`, "system");
  await addLog("Bot da tam dung. Kiem tra loi roi bam Tiep tuc de chay lai tu checkpoint.", "warning");
}

function requiresExistingChatContext(stage) {
  return stage === "script_section" || stage === "script_guidance" || stage === "image_prompt_repair";
}

function isImagePromptJobStage(stage) {
  return stage === "image_prompt" || stage === "image_prompt_repair";
}

function isRecoverableJobError(errorMessage) {
  // Delegates to the shared, precisely-pattern-matched implementation.
  // (P1-4) Previously matched bare substrings "limit"/"quota", which paused the
  // bot whenever normal text contained those words.
  return AutoPilotLib.isRecoverableJobError(errorMessage);
}

function isComposerBusyError(errorMessage) {
  const text = normalizeCommandText(errorMessage);
  return text.includes("nut gui") ||
    text.includes("vo hieu hoa") ||
    text.includes("send button") ||
    text.includes("disabled") ||
    text.includes("composer");
}

async function recoverChatGPTTab(state) {
  let tab = null;

  if (state.targetTabId) {
    try {
      tab = await chrome.tabs.get(state.targetTabId);
      if (tab && !isChatGPTTab(tab)) tab = null;
    } catch {
      tab = null;
    }
  }

  if (!tab) tab = await findChatGPTTab();

  if (!tab) {
    if (requiresExistingChatContext(state.activeJobStage)) {
      throw new Error("Da mat tab ChatGPT dang chua ngu canh. Can mo lai dung chat cu roi bam Tiep tuc.");
    }

    tab = await createChatGPTTab();
    await setStorage({ targetTabId: tab.id });
    return;
  }

  await setStorage({ targetTabId: tab.id });

  try {
    await reloadChatGPTTab(tab.id);
  } catch (error) {
    await addLog(`Khong reload duoc tab ChatGPT: ${error.message}`, "warning");
  }
}

async function syncScriptStateFromTab(state) {
  let tabId = state.targetTabId;
  if (!tabId) {
    const tab = await findChatGPTTab();
    if (tab) {
      tabId = tab.id;
      await setStorage({ targetTabId: tabId });
    }
  }
  if (!tabId) return state;

  try {
    const response = await sendMessageToTab(tabId, { action: "SYNC_CHAT_HISTORY" });
    if (response && response.success && Array.isArray(response.history)) {
      const history = response.history;
      
      const currentSections = Array.isArray(state.scriptSections) ? state.scriptSections : [];
      const currentNumbers = Array.isArray(state.scriptSectionNumbers) ? state.scriptSectionNumbers : deriveScriptSectionNumbers(currentSections);
      const sectionItems = [];
      let scriptOutline = state.scriptOutline || "";
      let outlineSectionCount = 0;
      const previousExpectedSections = Number(state.scriptExpectedSections) || 0;
      let finalContinueCount = 0;
      
      history.forEach((item) => {
        const promptText = String(item.prompt || "");
        const responseText = String(item.response || "");
        
        if (isScriptContinuePrompt(promptText, state)) {
          if (/\[AUTO_PILOT_(?:FINAL_CONTINUE|KET_THUC)\b/i.test(promptText)) {
            finalContinueCount++;
            if (sectionItems.length > 0) {
              const lastItem = sectionItems[sectionItems.length - 1];
              lastItem.response = lastItem.response + "\n\n" + responseText;
            } else if (currentSections.length > 0) {
              const lastIndex = currentSections.length - 1;
              sectionItems.push({
                number: Number(currentNumbers[lastIndex]) || lastIndex + 1,
                response: currentSections[lastIndex] + "\n\n" + responseText
              });
            } else {
              sectionItems.push({
                number: state.scriptExpectedSections || 1,
                response: responseText
              });
            }
          } else {
            let trackedNumber = extractTrackedPromptSectionNumber(promptText);
            const responseNumber = extractScriptSectionNumber(responseText);
            const fallbackNumber = sectionItems.length + 1;
            sectionItems.push({
              number: trackedNumber || responseNumber || fallbackNumber,
              response: responseText
            });
          }
        } else if (!isScriptGuidancePrompt(promptText, state)) {
          scriptOutline = responseText;
          outlineSectionCount = Number(item.outlineSectionCount) || detectScriptOutlineSectionCount(responseText);
        }
      });

      if (outlineSectionCount) {
        state.scriptExpectedSections = outlineSectionCount;
      }
      
      if (sectionItems.length > 0) {
        const merged = mergeScriptSectionItems(currentSections, currentNumbers, sectionItems);
        const nextFinalContinueAttempts = Math.max(
          Number(state.scriptFinalContinueAttempts) || 0,
          finalContinueCount
        );

        if (merged.sections.length < currentSections.length) {
          await addLog(
            `Bo qua dong bo lich su vi ChatGPT chi hien ${sectionItems.length}/${currentSections.length} section dang luu.`,
            "warning"
          );
          return state;
        }

        const changedSections = countChangedScriptSections(currentSections, merged.sections);
        if (
          changedSections === 0 &&
          currentSections.length > 0 &&
          nextFinalContinueAttempts === (Number(state.scriptFinalContinueAttempts) || 0)
        ) {
          return state;
        }

        const nextSectionIndex = merged.numbers.length
          ? Math.max(...merged.numbers) + 1
          : merged.sections.length + 1;
        
        await addLog(
          `Dong bo thanh cong: Da tim thay ${merged.sections.length} section trong lich su chat, cap nhat ${changedSections} section.`,
          "success"
        );
        
        const patch = {
          scriptSections: merged.sections,
          scriptSectionNumbers: merged.numbers,
          scriptSectionIndex: nextSectionIndex,
          scriptOutline,
          ...(outlineSectionCount ? { scriptExpectedSections: outlineSectionCount } : {}),
          lastGeneratedScript: merged.sections.join("\n\n"),
          scriptFinalContinueAttempts: nextFinalContinueAttempts
        };
        
        Object.assign(state, patch);
        await setStorage(patch);
      } else if (
        scriptOutline !== (state.scriptOutline || "") ||
        (outlineSectionCount && outlineSectionCount !== previousExpectedSections)
      ) {
        const patch = {
          scriptOutline,
          ...(outlineSectionCount ? { scriptExpectedSections: outlineSectionCount } : {})
        };
        Object.assign(state, patch);
        await setStorage(patch);
      }
    }
  } catch (error) {
    await addLog(`Khong the dong bo lich su chat: ${error.message}`, "warning");
  }
  return state;
}

async function recoverAndRetryJob(state, reason) {
  const attempts = state.jobRecoveryAttempts || 0;

  if (!isRecoverableJobError(reason) || attempts >= MAX_JOB_RECOVERY_ATTEMPTS) {
    await pauseOnError(reason, rewindWaitingPatch(state));
    return;
  }

  const nextAttempt = attempts + 1;
  await clearActiveJobAlarms();

  if (isComposerBusyError(reason)) {
    await addLog(`ChatGPT chua san sang gui tiep. Thu lai sau 20s (${nextAttempt}/${MAX_JOB_RECOVERY_ATTEMPTS}).`, "warning");
    await setStorage({
      activeJobId: null,
      activeJobStage: null,
      activeJobStartedAt: null,
      activeJobPromptText: "",
      activeJobLastProgressAt: null,
      activeJobLastHeartbeatAt: null,
      activeJobLastSyncAt: null,
      activeJobLastProgressEvent: "",
      activeJobLastTextLength: 0,
      activeJobLastForegroundAt: null,
      activeJobTabHidden: false,
      activeJobVisibilityState: "",
      activeJobParagraphIndex: null,
      activeJobSectionIndex: null,
      jobRecoveryAttempts: nextAttempt,
      ...rewindWaitingPatch(state)
    });
    scheduleWorkflowRunAfterSeconds(20);
    return;
  }

  await addLog(`Dang tu khoi phuc ChatGPT lan ${nextAttempt}/${MAX_JOB_RECOVERY_ATTEMPTS}: ${reason}`, "warning");

  try {
    await recoverChatGPTTab(state);
  } catch (error) {
    await pauseOnError(error.message, rewindWaitingPatch(state));
    return;
  }

  await setStorage({
    activeJobId: null,
    activeJobStage: null,
    activeJobStartedAt: null,
    activeJobPromptText: "",
    activeJobLastProgressAt: null,
    activeJobLastHeartbeatAt: null,
    activeJobLastSyncAt: null,
    activeJobLastProgressEvent: "",
    activeJobLastTextLength: 0,
    activeJobLastForegroundAt: null,
    activeJobTabHidden: false,
    activeJobVisibilityState: "",
    activeJobParagraphIndex: null,
    activeJobSectionIndex: null,
    jobRecoveryAttempts: nextAttempt,
    ...rewindWaitingPatch(state)
  });

  scheduleWorkflowRunAfterSeconds(5);
}

async function startChatGPTJob(promptText, jobState, forceNewChat) {
  const jobId = createJobId(jobState.activeJobStage);
  const now = Date.now();

  await setStorage({
    ...jobState,
    activeJobId: jobId,
    activeJobStartedAt: now,
    activeJobPromptText: promptText,
    activeJobLastProgressAt: now,
    activeJobLastHeartbeatAt: now,
    activeJobLastSyncAt: null,
    activeJobLastProgressEvent: "queued",
    activeJobLastTextLength: 0,
    activeJobLastForegroundAt: 0,
    activeJobTabHidden: false,
    activeJobVisibilityState: ""
  });
  scheduleJobTimeoutAlarm();
  scheduleJobWatchdogAlarm();

  try {
    await sendToChatGPT(promptText, {
      forceNewChat,
      jobId,
      requiresExistingChat: requiresExistingChatContext(jobState.activeJobStage),
      jobKind: isImagePromptJobStage(jobState.activeJobStage) ? "image_prompt" : "script"
    });
    return true;
  } catch (error) {
    const state = await getStorage(null);
    await recoverAndRetryJob(state, `Loi gui prompt: ${error.message}`);
    return false;
  }
}

async function handleJobProgress(message) {
  const state = await getStorage([
    "status",
    "activeJobId",
    "activeJobStartedAt",
    "activeJobLastProgressAt",
    "activeJobLastSyncAt",
    "activeJobLastTextLength",
    "activeJobTabHidden"
  ]);
  const jobId = message.jobId || null;

  if (state.status !== "running" || !jobId || jobId !== state.activeJobId) {
    return;
  }

  const now = Date.now();
  const event = message.event || "progress";
  const wasHidden = Boolean(state.activeJobTabHidden);
  const isHidden = Boolean(message.hidden);
  const previousTextLength = Number(state.activeJobLastTextLength) || 0;
  const messageTextLength = Number(message.textLength) || 0;
  const latestTextLength = Math.max(previousTextLength, messageTextLength);
  const isMeaningfulProgress = AutoPilotLib.isMeaningfulJobProgressEvent(
    event,
    messageTextLength,
    previousTextLength
  );

  const patch = {
    activeJobLastHeartbeatAt: now,
    activeJobLastProgressEvent: event,
    activeJobTabHidden: isHidden,
    activeJobVisibilityState: message.visibilityState || "",
    activeJobLastTextLength: latestTextLength
  };

  if (isMeaningfulProgress) {
    patch.activeJobLastProgressAt = now;
  }

  await setStorage(patch);

  if (isHidden && !wasHidden) {
    await addLog("Tab ChatGPT dang bi an/khong active. Bot se tu dua tab ve foreground de tranh treo.", "warning");
    scheduleJobWatchdogCheckAfterSeconds(30);
  }

  const startedAt = state.activeJobStartedAt || now;
  const waitingFastSyncMs = (isHidden || wasHidden)
    ? WAITING_ASSISTANT_HIDDEN_FAST_SYNC_MS
    : WAITING_ASSISTANT_FAST_SYNC_MS;
  const shouldFastSyncWaitingAssistant = event === "waiting_for_assistant" &&
    latestTextLength === 0 &&
    now - startedAt >= waitingFastSyncMs &&
    now - (Number(state.activeJobLastSyncAt) || 0) >= JOB_FAST_SYNC_THROTTLE_MS;

  if (shouldFastSyncWaitingAssistant) {
    await runJobWatchdog(false);
  }
}

async function completeActiveJobFromTabSync(state, source) {
  const promptText = state.activeJobPromptText || "";
  const details = await syncLatestAssistantResponseDetails(state, promptText, { allowFallback: false });
  const now = Date.now();
  const latestTextLength = details.latestTextLength || state.activeJobLastTextLength || 0;

  await setStorage({
    activeJobLastSyncAt: now,
    activeJobTabHidden: Boolean(details.hidden),
    activeJobVisibilityState: details.visibilityState || "",
    activeJobLastTextLength: latestTextLength
  });

  if (details.generating) {
    const previousTextLength = Number(state.activeJobLastTextLength) || 0;
    const textIncreased = latestTextLength > previousTextLength;
    const patch = {
      activeJobLastHeartbeatAt: now,
      activeJobLastProgressEvent: latestTextLength ? "sync_generating_text" : "sync_generating",
      activeJobLastTextLength: latestTextLength
    };
    if (textIncreased) {
      patch.activeJobLastProgressAt = now;
    }
    await setStorage(patch);
    return "generating";
  }

  if (details.response) {
    await addLog(`Da dong bo response tu tab ChatGPT sau khi watchdog phat hien job cham (${source}).`, "warning");
    await handleResponseComplete({
      action: "RESPONSE_COMPLETE",
      jobId: state.activeJobId,
      response: details.response,
      outlineSectionCount: details.outlineSectionCount,
      error: false
    });
    return "completed";
  }

  return "empty";
}

async function runJobWatchdog(forceTimeout = false) {
  if (jobWatchdogRunning) return;
  jobWatchdogRunning = true;

  try {
    const state = await getStorage(null);
    if (state.status !== "running" || !state.activeJobId) {
      await clearAlarm(ALARM_JOB_WATCHDOG);
      return;
    }

    const now = Date.now();
    const startedAt = state.activeJobStartedAt || now;
    const lastProgressAt = state.activeJobLastProgressAt || startedAt;
    const idleFor = now - lastProgressAt;
    const totalFor = now - startedAt;
    const hardTimedOut = forceTimeout || totalFor >= RESPONSE_TIMEOUT_MS;
    const lastEvent = state.activeJobLastProgressEvent || "none";
    const lastTextLength = state.activeJobLastTextLength || 0;
    const waitingAssistantFastSyncMs = state.activeJobTabHidden
      ? WAITING_ASSISTANT_HIDDEN_FAST_SYNC_MS
      : WAITING_ASSISTANT_FAST_SYNC_MS;
    const waitingAssistantTimedOut = lastEvent === "waiting_for_assistant" &&
      lastTextLength === 0 &&
      totalFor >= waitingAssistantFastSyncMs;

    const lastForegroundAt = state.activeJobLastForegroundAt || 0;
    if ((idleFor >= 60000 || waitingAssistantTimedOut) && now - lastForegroundAt >= JOB_FOREGROUND_REFRESH_MS) {
      try {
        const focusResult = await ensureTargetTabForeground(state);
        if (focusResult) {
          await sleep(FOREGROUND_SYNC_SETTLE_MS);
        }
        if (focusResult && focusResult.wasNotForeground) {
          await addLog("Watchdog: Phát hiện tab ChatGPT chạy nền bị idle. Đã đưa tab về foreground.", "normal");
        }
      } catch (error) {
        await addLog(`Khong the dua tab ChatGPT ve foreground: ${error.message}`, "warning");
      }
    }

    const isQueuedHang = lastEvent === "queued" && idleFor >= 35000;
    const idleTimedOut = idleFor >= JOB_IDLE_TIMEOUT_MS || isQueuedHang || waitingAssistantTimedOut;

    if (!hardTimedOut && !idleTimedOut) return;

    const idleSeconds = Math.round(idleFor / 1000);
    const reason = hardTimedOut
      ? "Qua thoi gian cho response tu ChatGPT."
      : (waitingAssistantTimedOut
          ? `Nghi bot bi lech DOM khi cho ChatGPT bat dau tra loi (${Math.round(totalFor / 1000)}s).`
          : (isQueuedHang
              ? `Khoi dong prompt bi treo trong trang thai queued (${idleSeconds}s).`
              : `Khong thay tien trinh tu ChatGPT trong ${idleSeconds}s.`));

    await setStorage({
      sheetProgressText: `${reason} Dang dong bo tab ChatGPT...`
    });
    await addLog(`${reason} Su kien cuoi: ${lastEvent}, text=${lastTextLength}. Dang dong bo lai tab truoc khi retry.`, "warning");

    try {
      const syncResult = await completeActiveJobFromTabSync(
        state,
        hardTimedOut ? "timeout" : (waitingAssistantTimedOut ? "waiting_assistant" : "idle")
      );
      if (syncResult === "completed") {
        return;
      }
      if (syncResult === "generating" && !hardTimedOut && idleFor < JOB_GENERATING_IDLE_TIMEOUT_MS) {
        return;
      }
      if (waitingAssistantTimedOut && !hardTimedOut && idleFor < JOB_IDLE_TIMEOUT_MS) {
        return;
      }
    } catch (error) {
      await addLog(`Khong dong bo duoc tab ChatGPT: ${error.message}`, "warning");
    }

    const latestState = await getStorage(null);
    if (latestState.status === "running" && latestState.activeJobId === state.activeJobId) {
      await recoverAndRetryJob(latestState, reason);
    }
  } finally {
    jobWatchdogRunning = false;
  }
}

async function runWorkflowStep() {
  const state = await getStorage(null);
  if (state.status !== "running") return;

  if (state.activeJobId) {
    const startedAt = state.activeJobStartedAt || 0;
    if (Date.now() - startedAt > RESPONSE_TIMEOUT_MS) {
      await runJobWatchdog(true);
    }
    return;
  }

  await runSheetWorkflowStep(state);
}

async function runSheetWorkflowStep(state) {
  const workflowState = state.sheetWorkflowState || "GET_TOPIC";
  const channel = state.selectedChannel;

  if (
    workflowState === "WAITING_FOR_SCRIPT" ||
    workflowState === "WAITING_FOR_SCRIPT_SECTION" ||
    workflowState === "WAITING_FOR_SCRIPT_GUIDANCE" ||
    workflowState === "WAITING_FOR_IMAGE_PROMPT"
  ) {
    await setStorage(rewindWaitingPatch(state));
    requestWorkflowRun();
    return;
  }

  switch (workflowState) {
    case "GET_TOPIC":
      await addLog("Dang tim topic moi tren Google Sheet...", "normal");
      await setStorage({ sheetProgressText: "Dang tim topic moi..." });

      try {
        await refreshConfigFromWebApp();
        const runId = state.currentRunId || createJobId("run");
        const res = await callWebApp({ action: "claimNextJob", channel, runId });
        if (!res.topic) {
          if (res.blocked) {
            const activeTopic = res.activeTopic ? ` Topic dang khoa: "${shortText(res.activeTopic, 30)}".` : "";
            await setStorage({
              status: "paused",
              sheetProgressText: `Kenh dang co job active cua tien trinh khac.${activeTopic}`,
              sheetProgressPercent: 0
            });
            await addLog(`Tam dung de tranh duplicate job.${activeTopic}`, "warning");
            return;
          }

          await setStorage({
            status: "completed",
            sheetProgressText: "Hoan thanh tat ca topic trong kenh.",
            sheetProgressPercent: 100
          });
          await addLog("Khong con topic nao can xu ly trong kenh nay.", "success");
          return;
        }

        const nextWorkflowState = res.workflowState ||
          ((res.scriptSheetName && res.paragraphs && res.paragraphs.length)
            ? "GENERATE_IMAGE_PROMPTS"
            : "GENERATE_SCRIPT");

        await setStorage({
          currentRow: res.row,
          currentChannel: res.channel || channel,
          currentTopic: res.topic,
          sheetWorkflowState: nextWorkflowState,
          sheetProgressText: `Topic moi: "${shortText(res.topic, 30)}"`,
          sheetProgressPercent: nextWorkflowState === "GENERATE_IMAGE_PROMPTS" ? 70 : 0,
          scriptSheetName: res.scriptSheetName || "",
          sheetParagraphs: res.paragraphs || [],
          sheetParagraphIndex: 0,
          scriptOutline: "",
          scriptSections: [],
          scriptSectionNumbers: [],
          scriptSectionIndex: 0,
          scriptExpectedSections: 0,
          scriptLastDiversitySection: 0,
          scriptFinalContinueAttempts: 0,
          scriptFirstContinueSent: false,
          tempImagePrompts: [],
          skipImagePrompts: false,
          currentImagePromptDraft: "",
          imagePromptRepairAttempts: 0,
          jobRecoveryAttempts: 0,
          currentRunId: res.runId || runId
        });
        requestWorkflowRun();
      } catch (error) {
        await pauseOnError(`Loi lay topic: ${error.message}`);
      }
      break;

    case "GENERATE_SCRIPT": {
      const topic = state.currentTopic;
      const promptTemplate = state.promptND || "Viet kich ban ve: {TOPIC}";
      const finalPrompt = applyPromptPlaceholders(promptTemplate, state, { topic });
      const expectedSections = detectExpectedSections(promptTemplate);

      await addLog(
        expectedSections
          ? `Tao kich ban ${expectedSections} section cho topic: "${shortText(topic, 35)}"`
          : `Tao kich ban cho topic: "${shortText(topic, 35)}"`,
        "info"
      );
      await setStorage({
        sheetWorkflowState: "WAITING_FOR_SCRIPT",
        sheetProgressText: "ChatGPT dang tao outline/context ban dau...",
        scriptOutline: "",
        scriptSections: [],
        scriptSectionNumbers: [],
        scriptSectionIndex: 1,
        scriptExpectedSections: expectedSections,
        scriptLastDiversitySection: 0,
        scriptFinalContinueAttempts: 0,
        scriptFirstContinueSent: false
      });

      await updateSheetJobProgress(state, {
        status: "SCRIPTING",
        stage: "GENERATE_SCRIPT",
        currentSection: 0,
        error: ""
      });

      await startChatGPTJob(finalPrompt, {
        activeJobStage: "script_outline",
      }, true);
      break;
    }

    case "GENERATE_SCRIPT_SECTION": {
      const updatedState = await syncScriptStateFromTab(state);
      
      const scriptSections = updatedState.scriptSections || [];
      const scriptSectionNumbers = updatedState.scriptSectionNumbers || deriveScriptSectionNumbers(scriptSections);
      let expectedSections = updatedState.scriptExpectedSections || 0;
      const outlineSectionCount = detectScriptOutlineSectionCount(updatedState.scriptOutline);
      if (outlineSectionCount && outlineSectionCount !== expectedSections) {
        await addLog(
          `Dieu chinh so section theo outline ChatGPT: ${outlineSectionCount} (truoc do ${expectedSections || "?"}).`,
          "warning"
        );
        expectedSections = outlineSectionCount;
        updatedState.scriptExpectedSections = outlineSectionCount;
        await setStorage({ scriptExpectedSections: outlineSectionCount });
      }
      const missingSections = findMissingScriptSections(scriptSectionNumbers, expectedSections);
      const sectionIndex = missingSections[0] || updatedState.scriptSectionIndex || 1;
      const sectionsDone = scriptSections.length;
      const latestSection = scriptSections[scriptSections.length - 1] || "";
      const latestNeedsContinue = responseRequestsContinuation(latestSection);
      const isBeyondExpected = Boolean(expectedSections && sectionIndex > expectedSections);
      const finalContinueAttempts = updatedState.scriptFinalContinueAttempts || 0;

      // The first response is context only. Once the first configured continue
      // prompt has been dispatched, never enqueue it again merely because the
      // service worker/reload woke up without an active job checkpoint.
      if (sectionsDone === 0 && updatedState.scriptFirstContinueSent) {
        await pauseOnError(
          "Lenh CONTINUE dau tien da duoc gui nhung chua dong bo duoc response. Tam dung de tranh gui trung sau reload.",
          {
            sheetWorkflowState: "GENERATE_SCRIPT_SECTION",
            sheetProgressText: "Da tam dung de tranh gui trung CONTINUE dau tien."
          }
        );
        return;
      }
      
      const hasFinal = scriptSections.some(isFinalScriptResponse);
      if (hasFinal || (isBeyondExpected && !latestNeedsContinue)) {
        await setStorage({
          lastGeneratedScript: scriptSections.join("\n\n"),
          sheetWorkflowState: "SAVE_SCRIPT"
        });
        requestWorkflowRun();
        return;
      }

      if (isBeyondExpected && latestNeedsContinue && finalContinueAttempts >= MAX_SCRIPT_FINAL_CONTINUES) {
        await pauseOnError(
          `ChatGPT van yeu cau CONTINUE sau ${MAX_SCRIPT_FINAL_CONTINUES} lan phan ket. Can kiem tra thu cong de tranh luu kich ban chua ket thuc.`,
          {
            sheetWorkflowState: "GENERATE_SCRIPT_SECTION",
            sheetProgressText: "Da tam dung vi ChatGPT van yeu cau CONTINUE o phan ket."
          }
        );
        return;
      }
      
      const diversityEvery = getScriptDiversityEvery(updatedState);
      const shouldSendDiversityPrompt = sectionsDone > 0 &&
        sectionsDone % diversityEvery === 0 &&
        updatedState.scriptLastDiversitySection !== sectionsDone &&
        (!expectedSections || sectionsDone < expectedSections);

      if (shouldSendDiversityPrompt) {
        const diversityPrompt = getScriptDiversityPrompt(updatedState);
        await addLog(`Gui lenh da dang cach dien dat sau ${sectionsDone} section.`, "info");
        await setStorage({
          sheetWorkflowState: "WAITING_FOR_SCRIPT_GUIDANCE",
          sheetProgressText: `Dang nhac ChatGPT da dang cach dien dat sau ${sectionsDone} section...`
        });

        await startChatGPTJob(diversityPrompt, {
          activeJobStage: "script_guidance",
          activeJobSectionIndex: sectionIndex
        }, false);
        break;
      }

      const isFinalContinue = isBeyondExpected && latestNeedsContinue;
      const continuePrompt = isFinalContinue
        ? getScriptFinalContinuePrompt(updatedState)
        : getScriptContinuePrompt(updatedState);
      const trackedContinuePrompt = isFinalContinue
        ? buildTrackedFinalPrompt(continuePrompt, expectedSections, updatedState)
        : buildTrackedSectionPrompt(continuePrompt, sectionIndex, expectedSections, updatedState);

      await addLog(
        isFinalContinue
          ? `Section cuoi van yeu cau CONTINUE. Gui lenh viet phan ket ${finalContinueAttempts + 1}/${MAX_SCRIPT_FINAL_CONTINUES}.`
          : `Gui CONTINUE de viet section ${sectionIndex}/${expectedSections || "?"}.`,
        "info"
      );
      await setStorage({
        sheetWorkflowState: "WAITING_FOR_SCRIPT_SECTION",
        sheetProgressText: isFinalContinue
          ? `ChatGPT dang viet phan ket bo sung ${finalContinueAttempts + 1}/${MAX_SCRIPT_FINAL_CONTINUES}`
          : `ChatGPT dang viet section ${sectionIndex}/${expectedSections || "?"}`,
        sheetProgressPercent: expectedSections ? Math.min(95, Math.round((sectionsDone / expectedSections) * 70)) : 0
      });

      await startChatGPTJob(trackedContinuePrompt, {
        activeJobStage: "script_section",
        activeJobSectionIndex: sectionIndex,
        // Persist this checkpoint together with the active job before dispatch.
        // If the service worker dies after ChatGPT accepts the prompt, recovery
        // must not enqueue the first CONTINUE a second time.
        ...(sectionsDone === 0 ? { scriptFirstContinueSent: true } : {})
      }, false);
      break;
    }

    case "SAVE_SCRIPT":
      await addLog("Dang luu kich ban vao Google Sheets...", "normal");
      await setStorage({ sheetProgressText: "Dang dong bo chat truoc khi luu kich ban..." });

      try {
        const syncedState = await syncScriptStateFromTab(state);
        const scriptSectionsToSave = syncedState.scriptSections || [];
        const scriptToSave = scriptSectionsToSave.length
          ? scriptSectionsToSave.join("\n\n")
          : syncedState.lastGeneratedScript;
        const expectedSectionsToSave = getExpectedSectionCountForSave(syncedState, scriptSectionsToSave);

        await setStorage({ sheetProgressText: "Dang luu kich ban..." });
        const res = await callWebApp({}, {
          action: "saveScript",
          channel,
          row: syncedState.currentRow,
          topic: syncedState.currentTopic,
          script: scriptToSave,
          scriptSections: scriptSectionsToSave,
          expectedSections: expectedSectionsToSave,
          runId: syncedState.currentRunId,
          txtExportFolderUrl: syncedState.txtExportFolderUrl || ""
        });

        if (res.txtFileUrl) {
          await addLog(`Da xuat TXT: ${res.txtFileName || "TXT"} - ${res.txtFileUrl}`, "success");
        } else if (res.txtExportError) {
          await addLog(`Luu Sheet xong nhung xuat TXT loi: ${res.txtExportError}`, "warning");
        }

        const shouldGenerateImagePrompts = hasImagePromptTemplate(syncedState);
        if (!shouldGenerateImagePrompts) {
          await addLog("Khong co prompt anh trong Sheet. Bo qua phan tao prompt anh.", "warning");
        }

        await setStorage({
          currentRow: res.row || syncedState.currentRow,
          scriptSheetName: res.scriptSheetName,
          sheetParagraphs: res.paragraphs || [],
          sheetParagraphIndex: 0,
          scriptOutline: "",
          scriptSections: [],
          scriptSectionNumbers: [],
          scriptSectionIndex: 0,
          scriptExpectedSections: res.sectionCount || expectedSectionsToSave || 0,
          scriptLastDiversitySection: 0,
          scriptFinalContinueAttempts: 0,
          scriptFirstContinueSent: false,
          tempImagePrompts: [],
          skipImagePrompts: !shouldGenerateImagePrompts,
          currentImagePromptDraft: "",
          imagePromptRepairAttempts: 0,
          sheetWorkflowState: shouldGenerateImagePrompts ? "GENERATE_IMAGE_PROMPTS" : "SAVE_IMAGE_PROMPTS",
          sheetProgressText: shouldGenerateImagePrompts
            ? "Da luu kich ban. Dang tao prompt anh..."
            : "Da luu kich ban. Khong co prompt anh nen bo qua phan anh...",
          sheetProgressPercent: 0
        });
        requestWorkflowRun();
      } catch (error) {
        await pauseOnError(`Loi luu kich ban: ${error.message}`);
      }
      break;

    case "GENERATE_IMAGE_PROMPTS": {
      const paragraphs = state.sheetParagraphs || [];
      const idx = state.sheetParagraphIndex || 0;

      if (!hasImagePromptTemplate(state)) {
        await addLog("Khong co prompt anh trong Sheet. Bo qua phan tao prompt anh.", "warning");
        await setStorage({
          skipImagePrompts: true,
          sheetWorkflowState: "SAVE_IMAGE_PROMPTS",
          sheetProgressText: "Khong co prompt anh nen bo qua phan anh..."
        });
        requestWorkflowRun();
        return;
      }

      if (idx >= paragraphs.length) {
        await setStorage({ sheetWorkflowState: "SAVE_IMAGE_PROMPTS" });
        requestWorkflowRun();
        return;
      }

      const currentParagraph = paragraphs[idx];
      const finalPrompt = buildImagePromptForParagraph(state, idx);
      if (!finalPrompt) {
        await setStorage({
          skipImagePrompts: true,
          sheetWorkflowState: "SAVE_IMAGE_PROMPTS",
          sheetProgressText: "Khong co prompt anh nen bo qua phan anh..."
        });
        requestWorkflowRun();
        return;
      }
      const percent = paragraphs.length ? Math.round((idx / paragraphs.length) * 100) : 0;

      await setStorage({
        sheetWorkflowState: "WAITING_FOR_IMAGE_PROMPT",
        sheetProgressText: `Dang tao prompt anh ${idx + 1}/${paragraphs.length}`,
        sheetProgressPercent: percent
      });
      await addLog(`Tao prompt anh ${idx + 1}/${paragraphs.length}: "${shortText(currentParagraph, 30)}"`, "info");

      await updateSheetJobProgress(state, {
        status: "IMAGING",
        stage: "GENERATE_IMAGE_PROMPTS",
        currentSection: idx + 1,
        error: ""
      });

      const imagePromptNewChatMode = (state.config && state.config.imagePromptNewChatMode) || "story";
      const forceNewImageChat = imagePromptNewChatMode === "section" ||
        (imagePromptNewChatMode === "story" && idx === 0);

      await startChatGPTJob(finalPrompt, {
        activeJobStage: "image_prompt",
        activeJobParagraphIndex: idx
      }, forceNewImageChat);
      break;
    }

    case "SAVE_IMAGE_PROMPTS": {
      const skipImagePrompts = state.skipImagePrompts === true || !hasImagePromptTemplate(state);
      await addLog(
        skipImagePrompts
          ? "Dang danh dau hoan thanh vi khong co prompt anh..."
          : "Dang luu danh sach prompt anh vao Google Sheets...",
        "normal"
      );
      await setStorage({
        sheetProgressText: skipImagePrompts
          ? "Dang bo qua prompt anh va danh dau hoan thanh..."
          : "Dang luu prompt anh..."
      });

      try {
        await callWebApp({}, {
          action: "saveImagePrompts",
          channel,
          row: state.currentRow,
          topic: state.currentTopic,
          scriptSheetName: state.scriptSheetName,
          imagePrompts: state.tempImagePrompts || [],
          skipImagePrompts,
          expectedSections: state.sheetParagraphs && state.sheetParagraphs.length
            ? state.sheetParagraphs.length
            : (state.scriptExpectedSections || 0),
          runId: state.currentRunId
        });

        await addLog(`Da hoan thanh topic "${shortText(state.currentTopic, 25)}".`, "success");
        const delay = state.delay || 5;
        const completedTopicsThisRun = (Number(state.completedTopicsThisRun) || 0) + 1;
        const runLimitTopics = Number(state.runLimitTopics) || 0;
        const reachedRunLimit = runLimitTopics > 0 && completedTopicsThisRun >= runLimitTopics;
        await setStorage({
          status: reachedRunLimit ? "completed" : state.status,
          sheetWorkflowState: "GET_TOPIC",
          sheetProgressText: reachedRunLimit
            ? `Da chay thu xong ${completedTopicsThisRun} topic. Kiem tra ket qua truoc khi chay tiep.`
            : `Cho ${delay}s de sang topic tiep theo...`,
          sheetProgressPercent: 100,
          currentRow: null,
          currentChannel: "",
          currentTopic: "",
          scriptSheetName: "",
          sheetParagraphs: [],
          sheetParagraphIndex: 0,
          scriptOutline: "",
          scriptSections: [],
          scriptSectionNumbers: [],
          scriptSectionIndex: 0,
          scriptExpectedSections: 0,
          scriptLastDiversitySection: 0,
          scriptFinalContinueAttempts: 0,
          tempImagePrompts: [],
          skipImagePrompts: false,
          currentImagePromptDraft: "",
          imagePromptRepairAttempts: 0,
          lastGeneratedScript: "",
          currentRunId: null,
          completedTopicsThisRun,
          runLimitTopics: reachedRunLimit ? 0 : runLimitTopics
        });
        if (reachedRunLimit) {
          await clearWorkflowAlarms();
          await addLog("Da dung sau khi chay thu 1 topic.", "success");
        } else {
          scheduleWorkflowRunAfterSeconds(delay);
        }
      } catch (error) {
        await pauseOnError(`Loi luu prompt anh: ${error.message}`);
      }
      break;
    }

    default:
      await pauseOnError(`Trang thai workflow khong hop le: ${workflowState}`);
      break;
  }
}

async function handleStart() {
  ensureBaseAlarms();
  const state = await getStorage(null);

  if (state.pausedJobResponse) {
    const patch = {
      status: "running",
      nextWorkflowRunAt: null,
      pausedWithActiveJob: false,
      pausedJobResponse: null
    };
    await setStorage(patch);
    await addLog("Khoi phuc workflow va xu ly response da luu khi tam dung.", "info");
    await handleResponseComplete(state.pausedJobResponse);
    return;
  }

  const patch = {
    status: "running",
    nextWorkflowRunAt: null,
    pausedWithActiveJob: false,
    pausedJobResponse: null,
    ...rewindWaitingPatch(state)
  };

  if (!state.currentRunId) {
    patch.currentRunId = createJobId("run");
  }

  await setStorage(patch);
  await addLog("Khoi chay he thong tu dong hoa.", "info");
  requestWorkflowRun();
}

async function handlePause() {
  const state = await getStorage(null);
  await clearWorkflowAlarms();

  const patch = {
    status: "paused",
    nextWorkflowRunAt: null
  };

  if (state.activeJobId) {
    patch.pausedWithActiveJob = true;
  } else {
    Object.assign(patch, {
      activeJobId: null,
      activeJobStage: null,
      activeJobStartedAt: null,
      activeJobPromptText: "",
      activeJobLastProgressAt: null,
      activeJobLastHeartbeatAt: null,
      activeJobLastSyncAt: null,
      activeJobLastProgressEvent: "",
      activeJobLastTextLength: 0,
      activeJobLastForegroundAt: null,
      activeJobTabHidden: false,
      activeJobVisibilityState: "",
      activeJobParagraphIndex: null,
      activeJobSectionIndex: null,
      jobRecoveryAttempts: 0,
      currentImagePromptDraft: "",
      imagePromptRepairAttempts: 0,
      ...rewindWaitingPatch(state)
    });
  }

  await setStorage(patch);
  await addLog("Da tam dung workflow.", "warning");
}

async function handleStop() {
  const state = await getStorage(null);
  await clearWorkflowAlarms();
  await cancelSheetJob(state);
  await setStorage({
    status: "idle",
    sheetWorkflowState: "GET_TOPIC",
    currentRow: null,
    currentChannel: "",
    currentTopic: "",
    scriptSheetName: "",
    sheetParagraphs: [],
    sheetParagraphIndex: 0,
    scriptOutline: "",
    scriptSections: [],
    scriptSectionNumbers: [],
    scriptSectionIndex: 0,
    scriptExpectedSections: 0,
    scriptLastDiversitySection: 0,
    scriptFinalContinueAttempts: 0,
    scriptFirstContinueSent: false,
    tempImagePrompts: [],
    skipImagePrompts: false,
    currentImagePromptDraft: "",
    imagePromptRepairAttempts: 0,
    sheetProgressText: "",
    sheetProgressPercent: 0,
    runLimitTopics: 0,
    completedTopicsThisRun: 0,
    activeJobId: null,
    activeJobStage: null,
    activeJobStartedAt: null,
    activeJobPromptText: "",
    activeJobLastProgressAt: null,
    activeJobLastHeartbeatAt: null,
    activeJobLastSyncAt: null,
    activeJobLastProgressEvent: "",
    activeJobLastTextLength: 0,
    activeJobLastForegroundAt: null,
    activeJobTabHidden: false,
    activeJobVisibilityState: "",
    activeJobParagraphIndex: null,
    activeJobSectionIndex: null,
    jobRecoveryAttempts: 0,
    targetTabId: null,
    currentRunId: null,
    nextWorkflowRunAt: null,
    pausedWithActiveJob: false,
    pausedJobResponse: null
  });
  await addLog("Da dung han va reset tien trinh.", "system");
}

async function handleResponseComplete(message) {
  const state = await getStorage(null);
  const jobId = message.jobId || null;

  if (state.status !== "running") {
    if (state.status === "paused" && state.pausedWithActiveJob && jobId && jobId === state.activeJobId) {
      await setStorage({
        pausedJobResponse: message
      });
      await addLog("Luu response hoan thanh tu ChatGPT vi dang tam dung workflow.", "warning");
    } else {
      await addLog("Bo qua response vi workflow khong con chay.", "warning");
    }
    return;
  }

  if (!jobId || jobId !== state.activeJobId) {
    await addLog("Bo qua response cu hoac khong khop jobId.", "warning");
    return;
  }

  await clearActiveJobAlarms();

  if (message.error) {
    await recoverAndRetryJob(state, `ChatGPT: ${message.response || "Khong ro loi"}`);
    return;
  }

  const responseText = String(message.response || "").trim();
  if (!responseText) {
    await recoverAndRetryJob(state, "ChatGPT tra ve response rong.");
    return;
  }

  if (AutoPilotLib.isProviderErrorResponseText(responseText)) {
    await recoverAndRetryJob(state, `ChatGPT provider/limit response: ${shortText(responseText, 180)}`);
    return;
  }

  await setStorage({ jobRecoveryAttempts: 0 });

  await handleSheetResponse(state, responseText, Number(message.outlineSectionCount) || 0);
}

function isValidImagePromptResponse(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return false;
  if (cleaned.length < 15) return false;
  const lower = cleaned.toLowerCase();
  
  const invalidPatterns = [
    "something went wrong",
    "error generating",
    "network error",
    "too many requests",
    "message limit",
    "rate limit",
    "quota exceeded",
    "please try again",
    "try again later",
    "try again after"
  ];
  
  if (invalidPatterns.some(pattern => lower.includes(pattern))) {
    return false;
  }
  return true;
}

async function handleSheetResponse(state, responseText, domOutlineSectionCount = 0) {
  // "script" is the legacy first-response stage. Treat it as outline too so
  // an in-flight job recovered across an extension update cannot save early.
  if (state.activeJobStage === "script_outline" || state.activeJobStage === "script") {
    const outlineSectionCount = domOutlineSectionCount || detectScriptOutlineSectionCount(responseText);
    const patch = {
      scriptOutline: responseText,
      sheetWorkflowState: "GENERATE_SCRIPT_SECTION",
      sheetProgressText: "Da nhan outline. Dang bat dau viet tung section...",
      activeJobId: null,
      activeJobStage: null,
      activeJobStartedAt: null
    };

    if (outlineSectionCount) {
      patch.scriptExpectedSections = outlineSectionCount;
      if (outlineSectionCount !== (state.scriptExpectedSections || 0)) {
        await addLog(
          `Dieu chinh so section theo outline ChatGPT: ${outlineSectionCount} (truoc do ${state.scriptExpectedSections || "?"}).`,
          "warning"
        );
      }
    }

    await setStorage(patch);
    requestWorkflowRun();
    return;
  }
  if (state.activeJobStage === "script_section") {
    const currentSections = state.scriptSections || [];
    const currentNumbers = state.scriptSectionNumbers || deriveScriptSectionNumbers(currentSections);
    const requestedSection = state.activeJobSectionIndex || state.scriptSectionIndex || (currentSections.length + 1);
    const expectedSections = state.scriptExpectedSections || 0;

    const isFinalContinueResponse = Boolean(expectedSections && requestedSection > expectedSections);
    const responseSection = isFinalContinueResponse ? 0 : extractScriptSectionNumber(responseText);

    if (!isFinalContinueResponse && expectedSections && requestedSection && !responseSection) {
      await pauseOnError(
        `ChatGPT khong bat dau bang Section ${requestedSection}. Can kiem tra chat truoc khi luu.`,
        {
          scriptSections: currentSections,
          scriptSectionNumbers: currentNumbers,
          scriptSectionIndex: requestedSection,
          lastGeneratedScript: currentSections.join("\n\n"),
          sheetWorkflowState: "GENERATE_SCRIPT_SECTION",
          sheetProgressText: `Da tam dung vi response khong bat dau bang Section ${requestedSection}.`,
          activeJobId: null,
          activeJobStage: null,
          activeJobStartedAt: null,
          activeJobSectionIndex: null
        }
      );
      return;
    }

    let scriptSections, scriptSectionNumbers, currentSection;
    if (isFinalContinueResponse) {
      scriptSections = [...currentSections];
      if (scriptSections.length > 0) {
        scriptSections[scriptSections.length - 1] = scriptSections[scriptSections.length - 1] + "\n\n" + responseText;
      } else {
        scriptSections.push(responseText);
      }
      scriptSectionNumbers = currentNumbers;
      currentSection = expectedSections;
    } else {
      currentSection = responseSection || requestedSection;
      const merged = mergeScriptSectionItems(currentSections, currentNumbers, [{
        number: currentSection,
        response: responseText
      }]);
      scriptSections = merged.sections;
      scriptSectionNumbers = merged.numbers;
    }

    const nextSection = scriptSectionNumbers.length
      ? Math.max(...scriptSectionNumbers) + 1
      : currentSection + 1;
    const needsContinuation = responseRequestsContinuation(responseText);
    const isBeyondExpected = Boolean(expectedSections && nextSection > expectedSections);
    const finalContinueAttempts = (state.scriptFinalContinueAttempts || 0) + (isFinalContinueResponse ? 1 : 0);
    const missingSections = findMissingScriptSections(scriptSectionNumbers, expectedSections);
    const shouldSave = isFinalScriptResponse(responseText) || (isBeyondExpected && !needsContinuation);
    const lastGeneratedScript = scriptSections.join("\n\n");

    if (responseSection && requestedSection && responseSection !== requestedSection) {
      await addLog(`Canh bao: Bot yeu cau section ${requestedSection} nhung ChatGPT tra ve Section ${responseSection}. Da canh theo so section thuc te.`, "warning");
    }

    if (missingSections.length && (shouldSave || isBeyondExpected)) {
      await pauseOnError(
        `Phat hien thieu section ${missingSections.join(", ")} trong khi ChatGPT da toi section ${Math.max(...scriptSectionNumbers)}. Can kiem tra chat truoc khi luu.`,
        {
          scriptSections,
          scriptSectionNumbers,
          scriptSectionIndex: missingSections[0],
          lastGeneratedScript,
          sheetWorkflowState: "GENERATE_SCRIPT_SECTION",
          sheetProgressText: `Da tam dung vi thieu section ${missingSections[0]}.`,
          activeJobId: null,
          activeJobStage: null,
          activeJobStartedAt: null,
          activeJobSectionIndex: null,
          scriptFinalContinueAttempts: finalContinueAttempts
        }
      );
      return;
    }

    if (isBeyondExpected && needsContinuation && finalContinueAttempts >= MAX_SCRIPT_FINAL_CONTINUES) {
      await pauseOnError(
        `ChatGPT van yeu cau CONTINUE sau ${MAX_SCRIPT_FINAL_CONTINUES} lan phan ket. Can kiem tra thu cong de tranh luu kich ban chua ket thuc.`,
        {
          scriptSections,
          scriptSectionNumbers,
          scriptSectionIndex: nextSection,
          lastGeneratedScript,
          sheetWorkflowState: "GENERATE_SCRIPT_SECTION",
          sheetProgressText: "Da tam dung vi ChatGPT van yeu cau CONTINUE o phan ket.",
          activeJobId: null,
          activeJobStage: null,
          activeJobStartedAt: null,
          activeJobSectionIndex: null,
          scriptFinalContinueAttempts: finalContinueAttempts
        }
      );
      return;
    }

    await setStorage({
      scriptSections,
      scriptSectionNumbers,
      scriptSectionIndex: nextSection,
      lastGeneratedScript,
      sheetWorkflowState: shouldSave ? "SAVE_SCRIPT" : "GENERATE_SCRIPT_SECTION",
      sheetProgressText: shouldSave
        ? "Da nhan du section. Dang luu kich ban..."
        : `Da nhan section ${currentSection}. Chuan bi section ${nextSection}...`,
      sheetProgressPercent: expectedSections ? Math.min(95, Math.round((scriptSections.length / expectedSections) * 70)) : 0,
      activeJobId: null,
      activeJobStage: null,
      activeJobStartedAt: null,
      activeJobSectionIndex: null,
      scriptFinalContinueAttempts: finalContinueAttempts
    });

    if (shouldSave) {
      requestWorkflowRun();
    } else {
      const delay = state.delay || 5;
      scheduleWorkflowRunAfterSeconds(delay);
    }
    return;
  }

  if (state.activeJobStage === "script_guidance") {
    const sectionsDone = (state.scriptSections || []).length;
    await setStorage({
      scriptLastDiversitySection: sectionsDone,
      sheetWorkflowState: "GENERATE_SCRIPT_SECTION",
      sheetProgressText: `Da nhac da dang cach dien dat sau ${sectionsDone} section.`,
      activeJobId: null,
      activeJobStage: null,
      activeJobStartedAt: null,
      activeJobSectionIndex: null
    });
    requestWorkflowRun();
    return;
  }

  if (isImagePromptJobStage(state.activeJobStage)) {
    const paragraphIdx = Number.isInteger(state.activeJobParagraphIndex)
      ? state.activeJobParagraphIndex
      : (state.sheetParagraphIndex || 0);

    const isValid = isValidImagePromptResponse(responseText);
    const repairAttempts = state.imagePromptRepairAttempts || 0;

    if (!isValid) {
      if (repairAttempts < MAX_IMAGE_PROMPT_REPAIR_ATTEMPTS) {
        const nextAttempt = repairAttempts + 1;
        await addLog(`Prompt ảnh rỗng hoặc lỗi. Đang thử lại lần ${nextAttempt}/${MAX_IMAGE_PROMPT_REPAIR_ATTEMPTS}...`, "warning");
        await setStorage({
          imagePromptRepairAttempts: nextAttempt,
          sheetWorkflowState: "GENERATE_IMAGE_PROMPTS",
          activeJobId: null,
          activeJobStage: null,
          activeJobStartedAt: null
        });
        scheduleWorkflowRunAfterSeconds(5);
        return;
      } else {
        await pauseOnError(`Sinh prompt ảnh cho chương ${paragraphIdx + 1} thất bại sau ${MAX_IMAGE_PROMPT_REPAIR_ATTEMPTS} lần thử lại. Nội dung phản hồi không hợp lệ: ${shortText(responseText, 60)}`, {
          sheetWorkflowState: "GENERATE_IMAGE_PROMPTS",
          sheetProgressText: `Đã tạm dừng do lỗi tạo prompt ảnh ở chương ${paragraphIdx + 1}.`,
          sheetParagraphIndex: paragraphIdx,
          imagePromptRepairAttempts: 0
        });
        return;
      }
    }

    const expectedCount = getExpectedImagePromptsPerSection(state);
    const draftPrefix = state.activeJobStage === "image_prompt_repair"
      ? String(state.currentImagePromptDraft || "").trim()
      : "";
    let combinedResponse = draftPrefix
      ? `${draftPrefix}\n\n${responseText}`.trim()
      : responseText;
    let actualCount = countImagePromptsInResponse(combinedResponse);

    if (actualCount < expectedCount) {
      await addLog(
        `Prompt anh section ${paragraphIdx + 1} dang dem ${actualCount}/${expectedCount}. Dang dong bo lai chat de tranh bat thieu som.`,
        "warning"
      );

      const rechecked = await recheckImagePromptResponse(state, paragraphIdx, expectedCount, combinedResponse);
      const latestState = await getStorage(["status", "activeJobId"]);
      if (latestState.status !== "running" || latestState.activeJobId !== state.activeJobId) {
        await addLog("Bo qua ket qua kiem tra lai prompt anh vi workflow da doi trang thai.", "warning");
        return;
      }

      combinedResponse = rechecked.response;
      actualCount = rechecked.count;

      if (actualCount >= expectedCount) {
        await addLog(
          `Dong bo lai thanh cong: prompt anh section ${paragraphIdx + 1} co du ${actualCount}/${expectedCount}.`,
          "success"
        );
      }
    }

    if (actualCount < expectedCount) {
      if (repairAttempts < MAX_IMAGE_PROMPT_REPAIR_ATTEMPTS) {
        const nextAttempt = repairAttempts + 1;
        await addLog(
          `Prompt anh section ${paragraphIdx + 1} moi co ${actualCount}/${expectedCount}. Dang yeu cau bo sung (${nextAttempt}/${MAX_IMAGE_PROMPT_REPAIR_ATTEMPTS}).`,
          "warning"
        );
        await setStorage({
          currentImagePromptDraft: combinedResponse,
          imagePromptRepairAttempts: nextAttempt,
          sheetWorkflowState: "WAITING_FOR_IMAGE_PROMPT",
          sheetProgressText: `Dang bo sung prompt anh section ${paragraphIdx + 1}: ${actualCount}/${expectedCount}`,
          activeJobId: null,
          activeJobStage: null,
          activeJobStartedAt: null,
          activeJobParagraphIndex: null
        });

        await startChatGPTJob(buildImagePromptRepairPrompt(expectedCount, actualCount), {
          activeJobStage: "image_prompt_repair",
          activeJobParagraphIndex: paragraphIdx
        }, false);
        return;
      }

      await pauseOnError(
        `Prompt anh section ${paragraphIdx + 1} chi co ${actualCount}/${expectedCount} prompt sau ${MAX_IMAGE_PROMPT_REPAIR_ATTEMPTS} lan bo sung. Can kiem tra chat truoc khi luu.`,
        {
          currentImagePromptDraft: combinedResponse,
          imagePromptRepairAttempts: repairAttempts,
          sheetWorkflowState: "GENERATE_IMAGE_PROMPTS",
          sheetParagraphIndex: paragraphIdx,
          sheetProgressText: `Da tam dung vi prompt anh section ${paragraphIdx + 1} thieu ${expectedCount - actualCount} prompt.`,
          activeJobId: null,
          activeJobStage: null,
          activeJobStartedAt: null,
          activeJobParagraphIndex: null
        }
      );
      return;
    }

    const tempImagePrompts = [
      ...(state.tempImagePrompts || []),
      {
        section: paragraphIdx + 1,
        response: combinedResponse
      }
    ];

    const nextParagraphIdx = paragraphIdx + 1;
    await setStorage({
      tempImagePrompts,
      sheetParagraphIndex: nextParagraphIdx,
      imagePromptRepairAttempts: 0,
      currentImagePromptDraft: "",
      sheetWorkflowState: "GENERATE_IMAGE_PROMPTS",
      activeJobId: null,
      activeJobStage: null,
      activeJobStartedAt: null,
      activeJobParagraphIndex: null
    });

    const delay = state.delay || 5;
    scheduleWorkflowRunAfterSeconds(delay);
    return;
  }

  await pauseOnError(`Stage response khong hop le: ${state.activeJobStage}`, rewindWaitingPatch(state));
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_SYNC_SELECTORS) {
    fetchSelectors().catch(() => {});
    return;
  }

  if (alarm.name === ALARM_WORKFLOW_HEARTBEAT) {
    resumeRunningWorkflowAfterWake("heartbeat").catch((error) => {
      addLog(`Workflow heartbeat error: ${error.message}`, "system");
    });
    return;
  }

  if (alarm.name === ALARM_JOB_WATCHDOG) {
    runJobWatchdog(false).catch((error) => {
      addLog(`Job watchdog error: ${error.message}`, "system");
    });
    return;
  }

  if (alarm.name === ALARM_NEXT_PROMPT || alarm.name === "retryAlarm" || alarm.name === ALARM_JOB_TIMEOUT) {
    if (alarm.name === ALARM_NEXT_PROMPT) {
      clearShortDelayTimer();
    }
    if (alarm.name === ALARM_JOB_TIMEOUT) {
      runJobWatchdog(true).catch((error) => {
        addLog(`Job timeout watchdog error: ${error.message}`, "system");
      });
    } else {
      requestWorkflowRun();
    }
  }
});

let activePorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepAlive") {
    activePorts.add(port);
    port.onMessage.addListener((msg) => {
      if (msg && msg.action === "ping") {
        // Ping received from content script, resets worker inactivity timer
      }
    });
    port.onDisconnect.addListener(() => {
      activePorts.delete(port);
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.action === "GET_SELECTORS") {
        const data = await getStorage(["selectorsCached"]);
        sendResponse({ success: true, selectors: data.selectorsCached || null });
        return;
      }

      if (message.action === "SELECTOR_HEARTBEAT_ALERT") {
        const issues = message.issues || [];
        const healed = message.healed;
        await addLog(
          `Canh bao Heartbeat: Loi selector tren ${issues.join(", ")} tai ${message.url}.${healed ? " Da tu dong khoi phuc ve selector mac dinh." : ""}`,
          healed ? "success" : "warning"
        );
        sendResponse({ success: true });
        return;
      }

      if (message.action === "START") {
        await handleStart();
        sendResponse({ success: true });
        return;
      }

      if (message.action === "PAUSE") {
        await handlePause();
        sendResponse({ success: true });
        return;
      }

      if (message.action === "STOP") {
        await handleStop();
        sendResponse({ success: true });
        return;
      }

      if (message.action === "RESPONSE_COMPLETE") {
        await handleResponseComplete(message);
        sendResponse({ success: true });
        return;
      }

      if (message.action === "JOB_PROGRESS") {
        await handleJobProgress(message);
        sendResponse({ success: true });
        return;
      }

      sendResponse({ success: false, error: "Unknown action" });
    } catch (error) {
      console.error("Background error in message handler:", error);
      if (message.action !== "GET_SELECTORS" && message.action !== "SELECTOR_HEARTBEAT_ALERT") {
        try {
          await pauseOnError(`Loi trong background message handler (${message.action}): ${error.message}`);
        } catch (inner) {
          console.error("Failed to pause on error:", inner);
        }
      }
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true;
});
