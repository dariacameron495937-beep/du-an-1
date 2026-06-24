/**
 * Google Apps Script backend for Super Auto.
 *
 * Final layout:
 * - tong quan
 * - chu de
 * - one sheet per channel: kenh 1, kenh 2, ...
 * - prompt
 *
 * Each topic is stored as one horizontal 3-column block on its channel sheet.
 * No per-row output tabs, no relational output tabs, no review/helper dashboard.
 */

const OVERVIEW_SHEET_NAME = "tổng quan";
const TOPIC_SHEET_NAME = "chủ đề";
const PROMPT_SHEET_NAME = "prompt";

const CONFIG_SHEET_NAMES = ["Auto Pilot Config", "Config"];
const IGNORED_SHEET_NAMES = ["ban sao cua channel topics 2026", "ten kenh"];
const PROMPT_HEADERS = ["prompt truyện", "prompt ảnh", "prompt sau 3 continue", "prompt continue", "prompt kết continue"];
const TXT_EXPORT_FOLDER_NAME = "super auto txt";
const TXT_EXPORT_FOLDER_ID_CONFIG_KEYS = [
  "txtexportfolderid",
  "txtexportfolderurl",
  "txtfolderid",
  "txtfolderurl",
  "drivefolderid",
  "drivefolderurl"
];
const TXT_EXPORT_FOLDER_RESOURCE_KEY_CONFIG_KEYS = [
  "txtexportfolderresourcekey",
  "txtfolderresourcekey",
  "drivefolderresourcekey"
];

const TOPIC_COL_CHANNEL = 1;
const TOPIC_COL_TOPIC = 2;
const TOPIC_COL_STATUS = 3;
const TOPIC_COL_ERROR = 4;
const TOPIC_COL_WARNING = 5;
const TOPIC_COL_NOTE = 6;
const TOPIC_COLUMN_COUNT = 6;

const STORY_TITLE_ROW = 1;
const STORY_HEADER_ROW = 2;
const STORY_FIRST_ROW = 3;
const DEFAULT_STORY_CHAPTER_COUNT = 20;
const MAX_STORY_CHAPTER_COUNT = 300;

const STORY_IMAGE_GAP_ROWS = 2;
const IMAGE_PROMPTS_PER_CHAPTER = 5;
const MAX_IMAGE_PROMPTS_PER_RESPONSE = MAX_STORY_CHAPTER_COUNT * IMAGE_PROMPTS_PER_CHAPTER;

const TOPIC_BLOCK_WIDTH = 3;

const STATUS_WRITING = "Đang viết";
const STATUS_SCRIPT_SAVED = "Đã lưu truyện";
const STATUS_IMAGING = "Đang tạo prompt ảnh";
const STATUS_DONE_VI = "Đã xong";
const STATUS_ERROR_VI = "Lỗi";

const JOB_STATUS_CLAIMED = "CLAIMED";
const JOB_STATUS_SCRIPTING = "SCRIPTING";
const JOB_STATUS_SCRIPT_SAVED = "SCRIPT_SAVED";
const JOB_STATUS_IMAGING = "IMAGING";
const JOB_STATUS_DONE = "DONE";
const JOB_STATUS_ERROR = "ERROR";

const JOB_STAGE_SCRIPT = "GENERATE_SCRIPT";
const JOB_STAGE_IMAGE = "GENERATE_IMAGE_PROMPTS";
const JOB_STAGE_DONE = "DONE";
const JOB_OWNER_PREFIX = "superAutoJobOwner:";

function getConfiguredApiToken() {
  return PropertiesService.getScriptProperties().getProperty("SUPER_AUTO_API_TOKEN") || "";
}

function validateApiToken(dataOrToken) {
  const configuredToken = getConfiguredApiToken();
  if (!configuredToken) {
    return true;
  }
  let requestToken = "";
  if (dataOrToken && typeof dataOrToken === "object") {
    requestToken = dataOrToken.token || "";
  } else if (typeof dataOrToken === "string") {
    requestToken = dataOrToken;
  }
  return requestToken === configuredToken;
}

function escapeSheetText(value) {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    const firstChar = trimmed.charAt(0);
    if (firstChar === "=" || firstChar === "+" || firstChar === "-" || firstChar === "@") {
      return "'" + value;
    }
  }
  return value;
}

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    const action = e.parameter.action;

    if (action === "getNextTopic" || action === "claimNextJob") {
      return jsonResponse({ error: "Action requires POST" });
    }

    if (!validateApiToken(e.parameter.token)) {
      return jsonResponse({ error: "Unauthorized" });
    }

    if (action === "getConfig") {
      return jsonResponse(getConfigData(ss));
    }

    if (action === "getCurrentJob") {
      return jsonResponse(withDocumentLock(function () {
        return getCurrentJobData(ss, e.parameter.channel, e.parameter.runId);
      }));
    }

    return jsonResponse({ error: "Invalid GET action: '" + action + "'" });
  } catch (error) {
    return handleRequestError(error);
  }
}

function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    const data = JSON.parse(e.postData.contents || "{}");

    if (!validateApiToken(data)) {
      return jsonResponse({ error: "Unauthorized" });
    }

    if (data.action === "getConfig") {
      return jsonResponse(getConfigData(ss));
    }

    if (data.action === "getNextTopic" || data.action === "claimNextJob") {
      return jsonResponse(withDocumentLock(function () {
        return getNextTopicData(ss, data.channel, data.runId);
      }));
    }

    if (data.action === "getCurrentJob") {
      return jsonResponse(withDocumentLock(function () {
        return getCurrentJobData(ss, data.channel, data.runId);
      }));
    }

    if (data.action === "saveScript") {
      return jsonResponse(withDocumentLock(function () {
        return saveScriptData(ss, data);
      }));
    }

    if (data.action === "saveImagePrompts") {
      return jsonResponse(withDocumentLock(function () {
        return saveImagePromptsData(ss, data);
      }));
    }

    if (data.action === "markError") {
      return jsonResponse(withDocumentLock(function () {
        return markErrorData(ss, data);
      }));
    }

    if (data.action === "cancelJob") {
      return jsonResponse(withDocumentLock(function () {
        return cancelJobData(ss, data);
      }));
    }

    if (data.action === "updateJob") {
      return jsonResponse(withDocumentLock(function () {
        return updateJobData(ss, data);
      }));
    }

    return jsonResponse({ error: "Invalid POST action" });
  } catch (error) {
    return handleRequestError(error);
  }
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleRequestError(error) {
  logServerError(error);
  return jsonResponse({ error: getPublicErrorMessage(error) });
}

function logServerError(error) {
  try {
    const message = error && error.stack ? error.stack : String(error);
    Logger.log(message);
  } catch (_ignored) {}
}

function getPublicErrorMessage(error) {
  const message = String(error && error.message || error || "Server error");
  const publicPatterns = [
    /^Invalid (GET|POST) action/i,
    /^Missing /i,
    /^Could not acquire spreadsheet lock$/i,
    /^Job is owned by another run$/i,
    /^Could not resolve topic row$/i
  ];

  return publicPatterns.some(function (pattern) { return pattern.test(message); })
    ? message
    : "Server error. Check Apps Script logs.";
}

function withDocumentLock(callback) {
  const lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { error: "Could not acquire spreadsheet lock" };
  }

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function getJobOwnerKey(ss, row) {
  return JOB_OWNER_PREFIX + ss.getId() + ":" + row;
}

function getJobOwner(ss, row) {
  if (!row) return "";
  const rawValue = PropertiesService.getScriptProperties().getProperty(getJobOwnerKey(ss, row)) || "";
  if (!rawValue) return "";

  const parts = rawValue.split("|");
  const runId = parts[0] || "";
  const timestamp = Number(parts[1]) || 0;

  // Nếu khóa đã quá 2 giờ (7,200,000 ms), tự động giải phóng khóa
  const LOCK_EXPIRATION_MS = 2 * 60 * 60 * 1000;
  if (timestamp && Date.now() - timestamp > LOCK_EXPIRATION_MS) {
    clearJobOwner(ss, row);
    return "";
  }

  return runId;
}

function setJobOwner(ss, row, runId) {
  if (!row) return;
  const props = PropertiesService.getScriptProperties();
  const key = getJobOwnerKey(ss, row);
  const cleanRunId = String(runId || "").trim();
  if (cleanRunId) {
    const value = cleanRunId + "|" + Date.now();
    props.setProperty(key, value);
  } else {
    props.deleteProperty(key);
  }
}

function clearJobOwner(ss, row) {
  if (!row) return;
  const props = PropertiesService.getScriptProperties();
  const key = getJobOwnerKey(ss, row);
  props.deleteProperty(key);
}

function validateJobOwner(ss, topicRow, runId) {
  if (!topicRow || !topicRow.row) return "Could not resolve topic row";

  const ownerRunId = getJobOwner(ss, topicRow.row);
  const requestedRunId = String(runId || "").trim();
  if (ownerRunId && !requestedRunId) {
    return "Missing runId for active job";
  }
  if (ownerRunId && requestedRunId && ownerRunId !== requestedRunId) {
    return "Job is owned by another run";
  }
  if (!ownerRunId && requestedRunId) {
    setJobOwner(ss, topicRow.row, requestedRunId);
  }
  return "";
}

function getConfigData(ss) {
  ensureBaseLayout(ss, false);

  const promptPair = getPromptPair(ss);
  const config = getAutoPilotConfig(ss);
  const topicRows = readTopicRows(ss);
  config.imagePromptsPerSection = IMAGE_PROMPTS_PER_CHAPTER;

  return {
    promptND: promptPair.promptND,
    promptAnh: promptPair.promptAnh,
    channels: getChannelsFromTopicRows(topicRows),
    channelStats: buildChannelStats(topicRows),
    promptStatus: {
      hasPromptND: Boolean(promptPair.promptND),
      hasPromptAnh: Boolean(promptPair.promptAnh),
      hasScriptDiversityPrompt: Boolean(promptPair.scriptDiversityPrompt)
    },
    topicCount: topicRows.length,
    config: config
  };
}

function getNextTopicData(ss, channel, runId) {
  if (!channel) return { error: "Missing channel" };

  ensureBaseLayout(ss, false);

  const effectiveRunId = String(runId || createServerJobId());
  const activeJob = findActiveJobData(ss, channel, effectiveRunId);
  if (activeJob) return activeJob;

  const rows = readTopicRows(ss);
  const requestedChannel = normalizeSheetName(channel);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (normalizeSheetName(row.channel) !== requestedChannel) continue;
    if (!isClaimableStatus(row.status)) continue;

    setTopicState(row.sheet, row.row, {
      status: STATUS_WRITING,
      error: "",
      warning: "",
      note: buildProgressNote("Đã nhận job", effectiveRunId)
    });
    setJobOwner(ss, row.row, effectiveRunId);
    refreshOverview(ss);

    return buildJobResponse(ss, row, {
      runId: effectiveRunId,
      status: JOB_STATUS_CLAIMED,
      workflowState: JOB_STAGE_SCRIPT
    });
  }

  return { topic: null, message: "All topics completed for channel: " + channel };
}

function getCurrentJobData(ss, channel, runId) {
  if (!channel) return { error: "Missing channel" };

  ensureBaseLayout(ss, false);

  const activeJob = findActiveJobData(ss, channel, runId);
  if (activeJob) return activeJob;

  return { topic: null, message: "No active job" };
}

function findActiveJobData(ss, channel, runId) {
  const rows = readTopicRows(ss);
  const requestedChannel = normalizeSheetName(channel);
  const requestedRunId = String(runId || "");

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (normalizeSheetName(row.channel) !== requestedChannel) continue;
    if (!isActiveStatus(row.status)) continue;

    const ownerRunId = getJobOwner(ss, row.row);
    if (ownerRunId && requestedRunId && ownerRunId !== requestedRunId) {
      return {
        topic: null,
        blocked: true,
        message: "Channel already has an active job owned by another run.",
        activeTopic: row.topic,
        row: row.row
      };
    }

    const effectiveRunId = ownerRunId || requestedRunId || createServerJobId();
    if (!ownerRunId) setJobOwner(ss, row.row, effectiveRunId);
    return buildJobResponse(ss, row, { runId: effectiveRunId });
  }

  return null;
}

function buildJobResponse(ss, topicRow, overrides) {
  const channelSheet = getChannelSheet(ss, topicRow.channel, false);
  const statusKind = getStatusKind(topicRow.status);
  const requestedWorkflowState = overrides && overrides.workflowState;
  const hasScript = requestedWorkflowState === JOB_STAGE_IMAGE ||
    statusKind === "script_saved" ||
    statusKind === "imaging";

  const paragraphs = hasScript && channelSheet
    ? readStoryParagraphsFromChannelSheet(channelSheet, topicRow.topic)
    : [];
  const sectionCount = channelSheet
    ? getTopicSectionCount(channelSheet, topicRow.topic, paragraphs.length || DEFAULT_STORY_CHAPTER_COUNT)
    : DEFAULT_STORY_CHAPTER_COUNT;

  const workflowState = hasScript && paragraphs.length
    ? JOB_STAGE_IMAGE
    : JOB_STAGE_SCRIPT;

  const jobStatus = workflowState === JOB_STAGE_IMAGE
    ? JOB_STATUS_SCRIPT_SAVED
    : JOB_STATUS_CLAIMED;

  return Object.assign({
    row: topicRow.row,
    channel: topicRow.channel,
    topic: topicRow.topic,
    runId: "",
    status: jobStatus,
    workflowState: workflowState,
    scriptSheetName: channelSheet ? channelSheet.getName() : topicRow.channel,
    paragraphs: paragraphs,
    sectionCount: sectionCount,
    expectedSections: sectionCount,
    currentSection: 0
  }, overrides || {});
}

function parseStoryChapterCount(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return Math.max(1, Math.min(MAX_STORY_CHAPTER_COUNT, Math.floor(number)));
  }
  return 0;
}

function normalizeStoryChapterCount(value, fallback) {
  const parsed = parseStoryChapterCount(value);
  if (parsed) return parsed;

  const fallbackNumber = Number(fallback);
  if (Number.isFinite(fallbackNumber) && fallbackNumber > 0) {
    return Math.max(1, Math.min(MAX_STORY_CHAPTER_COUNT, Math.floor(fallbackNumber)));
  }
  return DEFAULT_STORY_CHAPTER_COUNT;
}

function getImageTitleRow(sectionCount) {
  return STORY_FIRST_ROW + normalizeStoryChapterCount(sectionCount, DEFAULT_STORY_CHAPTER_COUNT) + STORY_IMAGE_GAP_ROWS;
}

function getImageHeaderRow(sectionCount) {
  return getImageTitleRow(sectionCount) + 1;
}

function getImageFirstRow(sectionCount) {
  return getImageTitleRow(sectionCount) + 2;
}

function getImageRowCount(sectionCount) {
  return normalizeStoryChapterCount(sectionCount, DEFAULT_STORY_CHAPTER_COUNT) * IMAGE_PROMPTS_PER_CHAPTER;
}

function getImageLastRow(sectionCount) {
  return getImageFirstRow(sectionCount) + getImageRowCount(sectionCount) - 1;
}

function getRequestedSectionCount(data, fallback) {
  if (data) {
    const explicit = parseStoryChapterCount(data.expectedSections || data.sectionCount || data.expectedSectionCount);
    if (explicit) return explicit;
  }
  return normalizeStoryChapterCount(fallback, DEFAULT_STORY_CHAPTER_COUNT);
}

function getTopicSectionCount(sheet, topic, fallback) {
  if (!sheet) return normalizeStoryChapterCount(fallback, DEFAULT_STORY_CHAPTER_COUNT);
  const startCol = findTopicStartColumn(sheet, topic);
  if (!startCol) return normalizeStoryChapterCount(fallback, DEFAULT_STORY_CHAPTER_COUNT);
  return getTopicSectionCountFromBlock(sheet, startCol, fallback);
}

function getTopicSectionCountFromBlock(sheet, startCol, fallback) {
  if (!sheet || !startCol) {
    return normalizeStoryChapterCount(fallback, DEFAULT_STORY_CHAPTER_COUNT);
  }

  const maxRows = sheet.getMaxRows();
  const values = sheet.getRange(STORY_FIRST_ROW, startCol, Math.max(1, maxRows - STORY_FIRST_ROW + 1), 1).getValues();
  let count = 0;

  for (let i = 0; i < values.length; i++) {
    const label = normalizeSheetName(values[i][0]);
    if (/^(?:chuong|chapter|section|part|phan|doan)\s+\d{1,3}$/.test(label)) {
      count++;
      continue;
    }
    if (count > 0) break;
  }

  return normalizeStoryChapterCount(count, fallback || DEFAULT_STORY_CHAPTER_COUNT);
}

function getTopicBlockUsedLastRow(sheet, startCol, fallbackSectionCount) {
  const maxRows = sheet.getMaxRows();
  const values = sheet.getRange(1, startCol, maxRows, TOPIC_BLOCK_WIDTH).getValues();
  let lastRow = 0;

  values.forEach(function (row, index) {
    const hasValue = row.some(function (cell) {
      return String(cell || "").trim();
    });
    if (hasValue) lastRow = index + 1;
  });

  return Math.max(lastRow, getImageLastRow(fallbackSectionCount));
}

function saveScriptData(ss, data) {
  const channel = String(data.channel || "").trim();
  const scriptText = String(data.script || "").trim();
  const scriptSections = Array.isArray(data.scriptSections)
    ? data.scriptSections.map(function (section) { return String(section || "").trim(); }).filter(Boolean)
    : [];

  if (!channel) return { error: "Missing channel" };
  if (!scriptText && !scriptSections.length) return { error: "Script is empty" };

  ensureBaseLayout(ss, false);

  const topicRow = resolveTopicRow(ss, data);
  if (!topicRow) return { error: "Could not resolve topic row" };
  const ownerError = validateJobOwner(ss, topicRow, data.runId);
  if (ownerError) return { error: ownerError };

  const config = getAutoPilotConfig(ss);

  // Override TXT export folder if provided by the client
  const folderUrlOrId = data.txtExportFolderUrl || data.txtExportFolderId;
  if (folderUrlOrId && String(folderUrlOrId).trim()) {
    const parsedFolder = parseDriveFolderConfig(folderUrlOrId);
    if (parsedFolder && parsedFolder.id) {
      config.txtExportFolderId = parsedFolder.id;
      config.txtExportFolderResourceKey = parsedFolder.resourceKey || "";
    }
  }

  const rawParagraphs = scriptSections.length ? scriptSections : splitScriptIntoParagraphs(scriptText, config);
  const cleanedParagraphRows = cleanScriptParagraphRows(rawParagraphs, config);
  const promptExpectedCount = detectExpectedStoryChapterCount(getPromptPair(ss).promptND);
  const sectionCount = getRequestedSectionCount(data, promptExpectedCount || DEFAULT_STORY_CHAPTER_COUNT);
  const paragraphs = cleanedParagraphRows.filter(Boolean).slice(0, sectionCount);

  if (!paragraphs.length) {
    return { error: "Could not split script into chapters" };
  }

  const channelSheet = getChannelSheet(ss, topicRow.channel || channel, true);
  const startCol = ensureTopicBlock(channelSheet, topicRow.topic, sectionCount);
  writeStoryBlock(channelSheet, startCol, topicRow.topic, rawParagraphs, cleanedParagraphRows, sectionCount);
  const txtExport = tryExportCleanScriptTxt(topicRow.channel || channel, topicRow.topic, paragraphs, config);

  const warning = buildChapterWarning(rawParagraphs.length, cleanedParagraphRows.length, sectionCount);
  const combinedWarning = [
    warning,
    txtExport && txtExport.error ? "TXT export failed: " + txtExport.error : ""
  ].filter(Boolean).join(" | ");
  setTopicState(topicRow.sheet, topicRow.row, {
    status: STATUS_SCRIPT_SAVED,
    error: "",
    warning: combinedWarning,
    note: buildProgressNote("Đã lưu truyện", data.runId)
  });
  refreshOverview(ss);

  return {
    success: true,
    row: topicRow.row,
    scriptSheetName: channelSheet.getName(),
    paragraphs: paragraphs,
    sectionCount: sectionCount,
    expectedSections: sectionCount,
    txtFileName: txtExport && txtExport.name || "",
    txtFileUrl: txtExport && txtExport.url || "",
    txtExportError: txtExport && txtExport.error || ""
  };
}

function tryExportCleanScriptTxt(channel, topic, paragraphs, config) {
  try {
    return exportCleanScriptTxt(channel, topic, paragraphs, config);
  } catch (error) {
    return {
      error: String(error && error.message || error || "Unknown TXT export error").slice(0, 500)
    };
  }
}

function exportCleanScriptTxt(channel, topic, paragraphs, config) {
  const content = buildTxtExportContent(paragraphs);
  if (!content) return { error: "No clean script content" };

  const folder = getOrCreateTxtExportFolder(config);
  const fileName = buildTxtExportFileName(channel, topic);
  trashExistingTxtExports(folder, fileName);

  const blob = Utilities.newBlob(content, "text/plain", fileName);
  const file = folder.createFile(blob);
  return {
    id: file.getId(),
    name: file.getName(),
    url: file.getUrl()
  };
}

function buildTxtExportContent(paragraphs) {
  return (paragraphs || [])
    .map(function (paragraph) { return String(paragraph || "").trim(); })
    .filter(Boolean)
    .join("\n\n");
}

function getOrCreateTxtExportFolder(config) {
  const folderId = config && config.txtExportFolderId;
  if (folderId) {
    const resourceKey = config && config.txtExportFolderResourceKey;
    return resourceKey
      ? DriveApp.getFolderByIdAndResourceKey(folderId, resourceKey)
      : DriveApp.getFolderById(folderId);
  }

  const folders = DriveApp.getFoldersByName(TXT_EXPORT_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(TXT_EXPORT_FOLDER_NAME);
}

function trashExistingTxtExports(folder, fileName) {
  const files = folder.getFilesByName(fileName);
  while (files.hasNext()) {
    files.next().setTrashed(true);
  }
}

function buildTxtExportFileName(channel, topic) {
  const channelPart = truncateTxtFileNamePart(sanitizeTxtFileNamePart(channel), 60) || "kenh";
  const topicPart = truncateTxtFileNamePart(sanitizeTxtFileNamePart(topic), 110) || "chu de";
  return channelPart + " - " + topicPart + ".txt";
}

function sanitizeTxtFileNamePart(value) {
  return String(value || "")
    .replace(/[<>:"\/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. -]+$/g, "")
    .replace(/^[. -]+/g, "")
    .trim();
}

function truncateTxtFileNamePart(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).replace(/[. -]+$/g, "").trim();
}

function saveImagePromptsData(ss, data) {
  const channel = String(data.channel || "").trim();
  if (!channel) return { error: "Missing channel" };

  ensureBaseLayout(ss, false);

  const topicRow = resolveTopicRow(ss, data);
  if (!topicRow) return { error: "Could not resolve topic row" };
  const ownerError = validateJobOwner(ss, topicRow, data.runId);
  if (ownerError) return { error: ownerError };

  if (data.skipImagePrompts === true) {
    setTopicState(topicRow.sheet, topicRow.row, {
      status: STATUS_DONE_VI,
      error: "",
      warning: "",
      note: buildProgressNote("Hoan thanh, bo qua prompt anh", data.runId)
    });
    clearJobOwner(ss, topicRow.row);
    refreshOverview(ss);

    return {
      success: true,
      row: topicRow.row,
      skippedImagePrompts: true
    };
  }

  const channelSheet = getChannelSheet(ss, topicRow.channel || channel, true);
  const requestedSectionCount = parseStoryChapterCount(data.expectedSections || data.sectionCount || data.expectedSectionCount);
  const startCol = ensureTopicBlock(channelSheet, topicRow.topic, requestedSectionCount || 0);
  const sectionCount = requestedSectionCount || getTopicSectionCountFromBlock(channelSheet, startCol, DEFAULT_STORY_CHAPTER_COUNT);

  const config = getAutoPilotConfig(ss);
  config.imagePromptsPerSection = IMAGE_PROMPTS_PER_CHAPTER;
  config.storySectionCount = sectionCount;
  const promptGroups = parseImagePromptGroups(data.imagePrompts, config);
  if (!countImagePrompts(promptGroups)) return { error: "Image prompts are empty" };

  // Validate sufficient prompts per chapter
  const paragraphs = readStoryParagraphsFromChannelSheet(channelSheet, topicRow.topic, sectionCount);
  const expectedChapters = Math.min(sectionCount, paragraphs.length || sectionCount);
  
  const groupMap = {};
  promptGroups.forEach(function (g) {
    groupMap[g.section] = g.prompts;
  });

  const missingDetails = [];
  for (let section = 1; section <= expectedChapters; section++) {
    const prompts = groupMap[section] || [];
    if (prompts.length < IMAGE_PROMPTS_PER_CHAPTER) {
      missingDetails.push("Chương " + section + " chỉ có " + prompts.length + "/" + IMAGE_PROMPTS_PER_CHAPTER + " prompt");
    }
  }

  if (missingDetails.length > 0) {
    return {
      error: "Thiếu prompt ảnh: " + missingDetails.join("; ")
    };
  }

  writeImagePromptBlock(channelSheet, startCol, topicRow.topic, promptGroups, sectionCount);

  setTopicState(topicRow.sheet, topicRow.row, {
    status: STATUS_DONE_VI,
    error: "",
    warning: "",
    note: buildProgressNote("Hoàn thành", data.runId)
  });
  clearJobOwner(ss, topicRow.row);
  refreshOverview(ss);

  return {
    success: true,
    row: topicRow.row,
    sectionCount: sectionCount,
    expectedSections: sectionCount,
    promptsSheetName: channelSheet.getName()
  };
}

function markErrorData(ss, data) {
  ensureBaseLayout(ss, false);

  const topicRow = resolveTopicRow(ss, data);
  if (!topicRow) return { error: "Could not resolve topic row" };
  const ownerError = validateJobOwner(ss, topicRow, data.runId);
  if (ownerError) return { error: ownerError };

  const message = String(data.message || "").slice(0, 1000);
  setTopicState(topicRow.sheet, topicRow.row, {
    status: STATUS_ERROR_VI,
    error: message,
    warning: data.stage || "",
    note: buildProgressNote("Lỗi", data.runId)
  });
  clearJobOwner(ss, topicRow.row);
  refreshOverview(ss);

  return { success: true };
}

function cancelJobData(ss, data) {
  ensureBaseLayout(ss, false);

  const topicRow = resolveTopicRow(ss, data);
  if (!topicRow) return { error: "Could not resolve topic row" };
  const ownerError = validateJobOwner(ss, topicRow, data.runId);
  if (ownerError) return { error: ownerError };

  const message = String(data.message || "Stopped by user").slice(0, 1000);
  setTopicState(topicRow.sheet, topicRow.row, {
    status: STATUS_ERROR_VI,
    error: message,
    warning: data.stage || "",
    note: buildProgressNote("Đã dừng", data.runId)
  });
  clearJobOwner(ss, topicRow.row);
  refreshOverview(ss);

  return { success: true };
}

function updateJobData(ss, data) {
  ensureBaseLayout(ss, false);

  const topicRow = resolveTopicRow(ss, data);
  if (!topicRow) return { error: "Could not resolve topic row" };
  const ownerError = validateJobOwner(ss, topicRow, data.runId);
  if (ownerError) return { error: ownerError };

  const mappedStatus = mapJobStatusToTopicStatus(data.status, data.stage, topicRow.status);
  const warning = buildJobWarning(data);
  setTopicState(topicRow.sheet, topicRow.row, {
    status: mappedStatus,
    error: data.error === undefined ? undefined : String(data.error || "").slice(0, 1000),
    warning: warning === undefined ? undefined : warning,
    note: buildProgressNote("Cập nhật job", data.runId)
  });

  return buildJobResponse(ss, readTopicRowBySheetRow(ss, topicRow.row), { runId: data.runId || "" });
}

function ensureBaseLayout(ss, createTopicBlocks) {
  ensureTopicSheet(ss);
  ensurePromptSheet(ss);
  refreshOverview(ss);

  if (createTopicBlocks) {
    const rows = readTopicRows(ss);
    rows.forEach(function (row) {
      if (!row.channel || !row.topic) return;
      const channelSheet = getChannelSheet(ss, row.channel, true);
      ensureTopicBlock(channelSheet, row.topic);
    });
  }
}

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("Super Auto")
    .addItem("Chuẩn hóa Bố cục Sheet", "setupSuperAutoLayout")
    .addItem("Cấp quyền xuất TXT", "authorizeTxtExport")
    .addToUi();
}

function setupSuperAutoLayout() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return withDocumentLock(function () {
    ensureBaseLayout(ss, true);
    return {
      success: true,
      message: "Đã chuẩn hóa bố cục Super Auto thành công!"
    };
  });
}

function authorizeTxtExport() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const config = getAutoPilotConfig(ss);
  const folder = getOrCreateTxtExportFolder(config);
  SpreadsheetApp.getUi().alert(
    "Đã cấp quyền xuất TXT.\n\nThư mục Drive: " + folder.getName() + "\n" + folder.getUrl()
  );
}

function ensureTopicSheet(ss) {
  const sheet = getOrCreateSheet(ss, TOPIC_SHEET_NAME);
  const headers = ["Tên kênh", "Chủ đề", "Tình trạng", "Lỗi", "Cảnh báo", "Ghi chú"];
  const current = sheet.getRange(1, 1, 1, TOPIC_COLUMN_COUNT).getValues()[0];
  const shouldSetHeaders = current.every(function (value) { return !String(value || "").trim(); }) ||
    normalizeSheetName(current[0]) !== normalizeSheetName(headers[0]) ||
    normalizeSheetName(current[1]) !== normalizeSheetName(headers[1]);

  if (shouldSetHeaders) {
    sheet.getRange(1, 1, 1, TOPIC_COLUMN_COUNT).setValues([headers]);
  }

  sheet.getRange(1, 1, 1, TOPIC_COLUMN_COUNT)
    .setFontWeight("bold")
    .setBackground("#e2e8f0")
    .setHorizontalAlignment("center");
  sheet.setFrozenRows(1);

  return sheet;
}

function ensurePromptSheet(ss) {
  const sheet = getOrCreateSheet(ss, PROMPT_SHEET_NAME);
  const shouldSetHeaders = !String(sheet.getRange(1, 1).getValue() || "").trim();
  if (shouldSetHeaders) {
    sheet.getRange(1, 1, 1, PROMPT_HEADERS.length).setValues([PROMPT_HEADERS]);
  } else {
    PROMPT_HEADERS.forEach(function (header, index) {
      const col = index + 1;
      if (!String(sheet.getRange(1, col).getValue() || "").trim()) {
        sheet.getRange(1, col).setValue(header);
      }
    });
  }
  sheet.getRange(1, 1, 1, PROMPT_HEADERS.length).setFontWeight("bold").setBackground("#e2e8f0");
  sheet.setFrozenRows(1);
  return sheet;
}

function refreshOverview(ss) {
  const topicSheet = ensureTopicSheet(ss);
  const overview = getOrCreateSheet(ss, OVERVIEW_SHEET_NAME);
  const overviewHeaders = ["STT", "Kênh", "Số chủ đề", "Đã xong"];
  const rows = readTopicRowsFromSheet(topicSheet);
  const order = [];
  const summary = {};

  rows.forEach(function (row) {
    if (!row.channel) return;
    const key = normalizeSheetName(row.channel);
    if (!summary[key]) {
      summary[key] = { channel: row.channel, total: 0, done: 0 };
      order.push(key);
    }
    summary[key].total++;
    if (getStatusKind(row.status) === "done") summary[key].done++;
  });

  overview.getRange(1, 1, 1, 4).setValues([overviewHeaders]);
  overview.getRange(1, 1, 1, 4).setFontWeight("bold").setBackground("#e2e8f0");

  const lastRow = Math.max(overview.getLastRow(), 2);
  if (lastRow > 1) {
    overview.getRange(2, 1, lastRow - 1, 4).clearContent();
  }

  const output = order.map(function (key, index) {
    const item = summary[key];
    return [index + 1, item.channel, item.total, item.done];
  });

  if (output.length) {
    overview.getRange(2, 1, output.length, 4).setValues(output);
  }

  overview.setFrozenRows(1);
}

function readTopicRows(ss) {
  return readTopicRowsFromSheet(ensureTopicSheet(ss));
}

function readTopicRowsFromSheet(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, TOPIC_COLUMN_COUNT).getValues();
  const rows = [];
  let currentChannel = "";

  values.forEach(function (row, index) {
    const explicitChannel = String(row[TOPIC_COL_CHANNEL - 1] || "").trim();
    if (explicitChannel) currentChannel = explicitChannel;

    const topic = String(row[TOPIC_COL_TOPIC - 1] || "").trim();
    if (!topic || isLikelyTopicHeader(topic)) return;

    rows.push({
      sheet: sheet,
      row: index + 2,
      channel: currentChannel,
      explicitChannel: explicitChannel,
      topic: topic,
      status: String(row[TOPIC_COL_STATUS - 1] || "").trim(),
      error: String(row[TOPIC_COL_ERROR - 1] || "").trim(),
      warning: String(row[TOPIC_COL_WARNING - 1] || "").trim(),
      note: String(row[TOPIC_COL_NOTE - 1] || "").trim()
    });
  });

  return rows;
}

function readTopicRowBySheetRow(ss, sheetRow) {
  const rows = readTopicRows(ss);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].row === sheetRow) return rows[i];
  }
  return null;
}

function resolveTopicRow(ss, data) {
  const rows = readTopicRows(ss);
  const explicitRow = Number(data && data.row);
  const expectedChannel = normalizeSheetName(data && data.channel);
  const expectedTopic = normalizeTopicValue(data && data.topic);

  if (Number.isFinite(explicitRow) && explicitRow >= 2) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.row !== explicitRow) continue;

      const channelOk = !expectedChannel || normalizeSheetName(row.channel) === expectedChannel;
      const topicOk = !expectedTopic || normalizeTopicValue(row.topic) === expectedTopic;
      if (channelOk && topicOk) return row;
    }
  }

  if (expectedTopic) {
    let fallback = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (expectedChannel && normalizeSheetName(row.channel) !== expectedChannel) continue;
      if (normalizeTopicValue(row.topic) !== expectedTopic) continue;
      if (isActiveStatus(row.status) || getStatusKind(row.status) === "error") return row;
      if (!fallback) fallback = row;
    }
    if (fallback) return fallback;
  }

  return null;
}

function setTopicState(sheet, row, state) {
  if (state.status !== undefined) sheet.getRange(row, TOPIC_COL_STATUS).setValue(escapeSheetText(state.status));
  if (state.error !== undefined) sheet.getRange(row, TOPIC_COL_ERROR).setValue(escapeSheetText(state.error));
  if (state.warning !== undefined) sheet.getRange(row, TOPIC_COL_WARNING).setValue(escapeSheetText(state.warning));
  if (state.note !== undefined) sheet.getRange(row, TOPIC_COL_NOTE).setValue(escapeSheetText(state.note));
}

function getChannelsFromTopicRows(rows) {
  const channels = [];
  const seen = {};

  (rows || []).forEach(function (row) {
    const channel = String(row.channel || "").trim();
    const key = normalizeSheetName(channel);
    if (!channel || seen[key]) return;
    seen[key] = true;
    channels.push(channel);
  });

  return channels;
}

function buildChannelStats(rows) {
  const stats = {};
  const order = [];

  (rows || []).forEach(function (row) {
    const channel = String(row.channel || "").trim();
    const key = normalizeSheetName(channel);
    if (!channel) return;

    if (!stats[key]) {
      stats[key] = {
        channel: channel,
        total: 0,
        pending: 0,
        active: 0,
        done: 0,
        error: 0,
        runnable: 0
      };
      order.push(key);
    }

    const item = stats[key];
    const kind = getStatusKind(row.status);
    item.total++;

    if (kind === "done") {
      item.done++;
    } else if (kind === "error") {
      item.error++;
      item.runnable++;
    } else if (isActiveStatus(row.status)) {
      item.active++;
    } else if (kind === "blank" || kind === "not_started") {
      item.pending++;
      item.runnable++;
    }
  });

  return order.map(function (key) {
    return stats[key];
  });
}

function getChannelSheet(ss, channel, createIfMissing) {
  const channelName = String(channel || "").trim();
  if (!channelName) return null;

  const wanted = normalizeSheetName(channelName);
  const sheets = getWorkingSheets(ss);
  for (let i = 0; i < sheets.length; i++) {
    if (normalizeSheetName(sheets[i].getName()) === wanted) return sheets[i];
  }

  if (!createIfMissing) return null;
  return ss.insertSheet(sanitizeSheetName(channelName));
}

function ensureTopicBlock(sheet, topic, sectionCount) {
  if (!sheet) throw new Error("Channel sheet is missing");

  let startCol = findTopicStartColumn(sheet, topic);
  const effectiveSectionCount = startCol
    ? getTopicSectionCountFromBlock(sheet, startCol, sectionCount || DEFAULT_STORY_CHAPTER_COUNT)
    : normalizeStoryChapterCount(sectionCount, DEFAULT_STORY_CHAPTER_COUNT);

  ensureRows(sheet, getImageLastRow(effectiveSectionCount));

  if (!startCol) {
    startCol = getNextTopicStartColumn(sheet);
  }

  ensureColumns(sheet, startCol + TOPIC_BLOCK_WIDTH - 1);
  prepareTopicBlock(sheet, startCol, topic, effectiveSectionCount);
  return startCol;
}

function prepareTopicBlock(sheet, startCol, topic, sectionCount) {
  const effectiveSectionCount = normalizeStoryChapterCount(sectionCount, DEFAULT_STORY_CHAPTER_COUNT);
  const imageTitleRow = getImageTitleRow(effectiveSectionCount);
  const imageHeaderRow = getImageHeaderRow(effectiveSectionCount);
  const imageFirstRow = getImageFirstRow(effectiveSectionCount);
  const imageRowCount = getImageRowCount(effectiveSectionCount);

  const titleRange = sheet.getRange(STORY_TITLE_ROW, startCol, 1, TOPIC_BLOCK_WIDTH);
  titleRange.breakApart();
  titleRange.merge()
    .setValue(escapeSheetText(topic))
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setBackground("#dbeafe");

  sheet.getRange(STORY_HEADER_ROW, startCol, 1, TOPIC_BLOCK_WIDTH)
    .setValues([["chương", "chưa lọc", "đã lọc"]])
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setBackground("#e2e8f0");

  const chapterLabels = [];
  for (let i = 1; i <= effectiveSectionCount; i++) {
    chapterLabels.push(["chương " + i]);
  }
  sheet.getRange(STORY_FIRST_ROW, startCol, effectiveSectionCount, 1).setValues(chapterLabels);

  const imageTitleRange = sheet.getRange(imageTitleRow, startCol, 1, TOPIC_BLOCK_WIDTH);
  imageTitleRange.breakApart();
  imageTitleRange.merge()
    .setValue(escapeSheetText("prompt ảnh - " + topic))
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setBackground("#dcfce7");

  sheet.getRange(imageHeaderRow, startCol, 1, TOPIC_BLOCK_WIDTH)
    .setValues([["ảnh", "prompt", "ghi chú"]])
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setBackground("#e2e8f0");

  const imageLabels = [];
  for (let chapter = 1; chapter <= effectiveSectionCount; chapter++) {
    for (let promptNo = 1; promptNo <= IMAGE_PROMPTS_PER_CHAPTER; promptNo++) {
      imageLabels.push([chapter + "." + promptNo]);
    }
  }
  sheet.getRange(imageFirstRow, startCol, imageRowCount, 1).setValues(imageLabels);

  sheet.getRange(STORY_FIRST_ROW, startCol + 1, effectiveSectionCount, 2).setWrap(true);
  sheet.getRange(imageFirstRow, startCol + 1, imageRowCount, 1).setWrap(false);
}

function findTopicStartColumn(sheet, topic) {
  const normalizedTopic = normalizeTopicValue(topic);
  if (!normalizedTopic) return 0;

  const lastCol = Math.max(sheet.getLastColumn(), sheet.getMaxColumns(), 1);
  const titleValues = sheet.getRange(STORY_TITLE_ROW, 1, 1, lastCol).getValues()[0];

  for (let col = 1; col <= lastCol; col++) {
    const storyTitle = normalizeTopicValue(titleValues[col - 1]);
    if (storyTitle === normalizedTopic) {
      return normalizeTopicStartColumn(col);
    }
  }

  return 0;
}

function getNextTopicStartColumn(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const titleValues = sheet.getRange(STORY_TITLE_ROW, 1, 1, lastCol).getValues()[0];
  let lastTopicCol = 0;

  for (let col = 1; col <= lastCol; col++) {
    if (String(titleValues[col - 1] || "").trim()) {
      lastTopicCol = Math.max(lastTopicCol, normalizeTopicStartColumn(col));
    }
  }

  return lastTopicCol ? lastTopicCol + TOPIC_BLOCK_WIDTH : 1;
}

function normalizeTopicStartColumn(col) {
  return Math.floor((col - 1) / TOPIC_BLOCK_WIDTH) * TOPIC_BLOCK_WIDTH + 1;
}

function writeStoryBlock(sheet, startCol, topic, rawParagraphs, cleanedParagraphs, sectionCount) {
  const effectiveSectionCount = normalizeStoryChapterCount(sectionCount, DEFAULT_STORY_CHAPTER_COUNT);
  const clearRows = getTopicBlockUsedLastRow(sheet, startCol, effectiveSectionCount);
  sheet.getRange(1, startCol, clearRows, TOPIC_BLOCK_WIDTH).breakApart().clearContent();
  prepareTopicBlock(sheet, startCol, topic, effectiveSectionCount);

  const rows = [];
  for (let i = 0; i < effectiveSectionCount; i++) {
    rows.push([
      "chương " + (i + 1),
      escapeSheetText(rawParagraphs[i] || ""),
      escapeSheetText(cleanedParagraphs[i] || "")
    ]);
  }

  sheet.getRange(STORY_FIRST_ROW, startCol, effectiveSectionCount, TOPIC_BLOCK_WIDTH).setValues(rows);
  sheet.getRange(STORY_FIRST_ROW, startCol + 1, effectiveSectionCount, 2)
    .setWrap(true)
    .setVerticalAlignment("top");
}

function writeImagePromptBlock(sheet, startCol, topic, promptGroups, sectionCount) {
  const effectiveSectionCount = normalizeStoryChapterCount(sectionCount, getTopicSectionCountFromBlock(sheet, startCol, DEFAULT_STORY_CHAPTER_COUNT));
  const imageTitleRow = getImageTitleRow(effectiveSectionCount);
  const imageFirstRow = getImageFirstRow(effectiveSectionCount);
  const imageRowCount = getImageRowCount(effectiveSectionCount);
  const clearRows = Math.max(
    getTopicBlockUsedLastRow(sheet, startCol, effectiveSectionCount) - imageTitleRow + 1,
    getImageLastRow(effectiveSectionCount) - imageTitleRow + 1
  );
  sheet.getRange(imageTitleRow, startCol, clearRows, TOPIC_BLOCK_WIDTH).breakApart().clearContent();
  prepareTopicBlock(sheet, startCol, topic, effectiveSectionCount);

  const promptMap = {};
  promptGroups.forEach(function (group) {
    if (group.section < 1 || group.section > effectiveSectionCount) return;
    group.prompts.forEach(function (prompt, index) {
      const promptNo = index + 1;
      if (promptNo > IMAGE_PROMPTS_PER_CHAPTER) return;
      promptMap[group.section + "." + promptNo] = prompt;
    });
  });

  const rows = [];
  for (let chapter = 1; chapter <= effectiveSectionCount; chapter++) {
    for (let promptNo = 1; promptNo <= IMAGE_PROMPTS_PER_CHAPTER; promptNo++) {
      const label = chapter + "." + promptNo;
      rows.push([label, escapeSheetText(promptMap[label] || "")]);
    }
  }

  sheet.getRange(imageFirstRow, startCol, imageRowCount, 2).setValues(rows);
  sheet.getRange(imageFirstRow, startCol + 1, imageRowCount, 1)
    .setWrap(false)
    .setVerticalAlignment("top");
}

function readStoryParagraphsFromChannelSheet(sheet, topic, sectionCount) {
  if (!sheet) return [];

  const startCol = findTopicStartColumn(sheet, topic);
  if (!startCol) return [];

  const effectiveSectionCount = normalizeStoryChapterCount(sectionCount, getTopicSectionCountFromBlock(sheet, startCol, DEFAULT_STORY_CHAPTER_COUNT));
  const values = sheet.getRange(STORY_FIRST_ROW, startCol + 1, effectiveSectionCount, 2).getValues();
  return values.map(function (row) {
    const cleaned = String(row[1] || "").trim();
    const raw = String(row[0] || "").trim();
    return cleaned || raw;
  }).filter(Boolean);
}

function isLikelyValidImagePromptText(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return false;
  if (cleaned.length < 15) return false;

  if (isImagePromptNoise(cleaned)) return false;
  if (isLikelyImagePromptTitleOnly(cleaned)) return false;

  const lower = removeDiacritics(cleaned.toLowerCase());
  const errorPatterns = [
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

  if (errorPatterns.some(function (pattern) { return lower.indexOf(pattern) !== -1; })) {
    return false;
  }

  const metaPatterns = [
    /^(here is|here are|below are)\b/,
    /^pasted text(?:\s*\(\d+\))?(?:\.txt)?$/,
    /^van ban da dan(?:\s*\(\d+\))?(?:\.txt)?$/,
    /^tai lieu$/,
    /^document$/,
    /^uploaded (?:file|document)/
  ];

  if (metaPatterns.some(function (pattern) { return pattern.test(lower); })) {
    return false;
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;

  return true;
}

function parseImagePromptGroups(imagePromptResponses, config) {
  const expected = IMAGE_PROMPTS_PER_CHAPTER;
  const sectionLimit = normalizeStoryChapterCount(
    config && config.storySectionCount,
    MAX_STORY_CHAPTER_COUNT
  );
  const promptGroups = [];

  if (!Array.isArray(imagePromptResponses)) return promptGroups;

  imagePromptResponses.forEach(function (entry, responseIndex) {
    if (!entry) return;
    const section = getImagePromptEntrySection(entry, responseIndex, sectionLimit);
    if (!section) return;
    const response = getImagePromptEntryText(entry);
    if (!response) return;
    let prompts = [];
    const splitPrompts = splitImagePromptResponse(response);
    splitPrompts.forEach(function (prompt) {
      const cleaned = cleanImagePrompt(prompt, config);
      if (cleaned && isLikelyValidImagePromptText(cleaned)) {
        prompts.push(cleaned);
      }
    });

    if (prompts.length === 0 && splitPrompts.length <= 1 && isLikelyValidImagePromptText(response)) {
      prompts.push(String(response || "").trim());
    }

    if (prompts.length > expected) {
      prompts = prompts.slice(0, expected);
    }

    if (prompts.length > 0) {
      promptGroups.push({
        section: section,
        prompts: prompts
      });
    }
  });

  return promptGroups;
}

function getImagePromptEntrySection(entry, fallbackIndex, maxSectionCount) {
  const limit = normalizeStoryChapterCount(maxSectionCount, MAX_STORY_CHAPTER_COUNT);
  if (entry && typeof entry === "object") {
    const explicitSection = Number(entry.section || entry.chapter || entry.chapterNumber);
    if (Number.isFinite(explicitSection) && explicitSection >= 1 && explicitSection <= limit) {
      return Math.floor(explicitSection);
    }
    if (Number.isFinite(explicitSection)) return 0;
  }
  const fallbackSection = fallbackIndex + 1;
  return fallbackSection <= limit ? fallbackSection : 0;
}

function getImagePromptEntryText(entry) {
  if (entry && typeof entry === "object") {
    return String(entry.response || entry.text || entry.prompt || "");
  }
  return String(entry || "");
}

function countImagePrompts(promptGroups) {
  return promptGroups.reduce(function (count, group) {
    return count + group.prompts.length;
  }, 0);
}

function getPromptPair(ss) {
  const promptSheet = getSheetByNameNormalized(ss, PROMPT_SHEET_NAME);
  const promptND = promptSheet ? readPromptColumn(promptSheet, ["prompt truyện", "prompt truyen", "prompt nd"], 1) : "";
  const promptAnh = promptSheet ? readPromptColumn(promptSheet, ["prompt ảnh", "prompt anh", "prompt image"], 2) : "";
  const scriptDiversityPrompt = promptSheet
    ? readPromptColumn(promptSheet, [
        "prompt sau 3 continue",
        "prompt sau 3 lan continue",
        "prompt sau moi 3 continue",
        "prompt sau mỗi 3 continue",
        "prompt nhac sau 3 continue",
        "prompt nhắc sau 3 continue",
        "prompt da dang",
        "prompt đa dạng",
        "script diversity prompt"
      ], 3)
    : "";
  const scriptContinuePrompt = promptSheet
    ? readPromptColumn(promptSheet, [
        "prompt continue",
        "prompt tiep tuc",
        "prompt tiếp tục",
        "script continue prompt",
        "continue prompt"
      ], 4)
    : "";
  const scriptFinalContinuePrompt = promptSheet
    ? readPromptColumn(promptSheet, [
        "prompt kết continue",
        "prompt ket continue",
        "prompt ket thuc continue",
        "prompt kết thúc continue",
        "prompt final continue",
        "script final continue prompt",
        "final continue prompt"
      ], 5)
    : "";

  return {
    promptND: promptND,
    promptAnh: promptAnh,
    scriptDiversityPrompt: scriptDiversityPrompt,
    scriptContinuePrompt: scriptContinuePrompt,
    scriptFinalContinuePrompt: scriptFinalContinuePrompt
  };
}

function readPromptColumn(sheet, headerCandidates, fallbackCol) {
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), fallbackCol);
  if (lastRow < 1) return "";

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const wanted = headerCandidates.map(normalizeSheetName);
  let col = fallbackCol;

  for (let i = 0; i < headers.length; i++) {
    if (wanted.indexOf(normalizeSheetName(headers[i])) !== -1) {
      col = i + 1;
      break;
    }
  }

  if (lastRow >= 2) {
    const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      const text = String(values[i][0] || "").trim();
      if (text) return text;
    }
  }

  return "";
}

function getAutoPilotConfig(ss) {
  const prompts = getPromptPair(ss);
  const promptND = prompts.promptND || "";
  const isVi = isVietnameseText(promptND);

  const config = {
    scriptSplitMode: "auto",
    minParagraphLength: 0,
    scriptCleanMode: "story",
    imagePromptCleanMode: "none",
    imagePromptOutputMode: "prompt_only",
    imagePromptsPerSection: IMAGE_PROMPTS_PER_CHAPTER,
    requireCompleteImagePrompts: false,
    txtExportFolderId: "",
    txtExportFolderResourceKey: "",
    scriptContinuePrompt: prompts.scriptContinuePrompt || (isVi ? 'VIẾT TIẾP không dùng dấu "—"' : 'CONTINUE do not use "—"'),
    scriptFinalContinuePrompt: prompts.scriptFinalContinuePrompt || (isVi
      ? 'VIẾT TIẾP phần kết thúc câu chuyện ngay bây giờ. Không hỏi thêm lệnh VIẾT TIẾP khác. Kết thúc truyện bằng chính xác cụm từ: Hết truyện. Chúc ngủ ngon.'
      : 'CONTINUE with the final wind-down and ending now. Do not ask for another CONTINUE. End the story with exactly: End of script. Sweet dreams.'),
    scriptDiversityEvery: 3,
    scriptDiversityPrompt: prompts.scriptDiversityPrompt || (isVi
      ? 'Từ các chương tiếp theo, hãy đa dạng cách dẫn chuyện, cách mở bí mật và cách tạo căng thẳng. Không lặp lại cùng một kiểu câu hoặc cùng một công thức chuyển cảnh quá nhiều lần. Vẫn giữ đúng chủ đề hôn nhân gia đình, ADN, con ruột, phản bội, sự thật bị che giấu và báo ứng. Chỉ trả lời: Đã hiểu.'
      : 'From the next sections onward, vary the phrasing, transitions, reveals, and tension beats. Do not repeat the same sentence pattern or scene-opening formula too often. Keep the story on its current topic and only reply: Understood.'),
    imagePromptNewChatMode: "story"
  };

  const sheet = getSheetByNameAny(ss, CONFIG_SHEET_NAMES);
  if (!sheet || sheet.getLastRow() < 1) return config;

  const values = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
  values.forEach(function (row) {
    const key = removeDiacritics(String(row[0] || "").trim().toLowerCase()).replace(/\s+/g, "");
    const rawValue = String(row[1] || "").trim();
    const value = rawValue.toLowerCase();
    if (!key || !rawValue) return;

    if (TXT_EXPORT_FOLDER_ID_CONFIG_KEYS.indexOf(key) !== -1) {
      const parsedFolder = parseDriveFolderConfig(rawValue);
      config.txtExportFolderId = parsedFolder.id;
      if (parsedFolder.resourceKey) config.txtExportFolderResourceKey = parsedFolder.resourceKey;
    }
    if (TXT_EXPORT_FOLDER_RESOURCE_KEY_CONFIG_KEYS.indexOf(key) !== -1) {
      config.txtExportFolderResourceKey = rawValue;
    }
    if (key === "scriptsplitmode" && ["auto", "heading", "blank", "line"].indexOf(value) !== -1) {
      config.scriptSplitMode = value;
    }
    if (key === "minparagraphlength") {
      const minLength = Number(value);
      if (!isNaN(minLength) && minLength >= 0) config.minParagraphLength = minLength;
    }
    if (key === "scriptcleanmode" && ["story", "none"].indexOf(value) !== -1) {
      config.scriptCleanMode = value;
    }
    if (key === "imagepromptcleanmode" && ["none", "strip_label", "last_paragraph"].indexOf(value) !== -1) {
      config.imagePromptCleanMode = value;
    }
    if (key === "scriptcontinueprompt") {
      config.scriptContinuePrompt = rawValue;
    }
    if (key === "scriptfinalcontinueprompt") {
      config.scriptFinalContinuePrompt = rawValue;
    }
    if (key === "scriptdiversityevery") {
      const every = Number(value);
      if (!isNaN(every) && every > 0) config.scriptDiversityEvery = every;
    }
    if (key === "scriptdiversityprompt" || key === "promptsau3continue" || key === "promptsau3lancontinue" || key === "promptnhacsau3continue") {
      config.scriptDiversityPrompt = rawValue;
    }
    if (key === "imagepromptnewchatmode" && ["story", "section", "never"].indexOf(value) !== -1) {
      config.imagePromptNewChatMode = value;
    }
    if (key === "requirecompleteimageprompts" || key === "requireimagepromptcomplete" || key === "requireimagepromptscomplete") {
      config.requireCompleteImagePrompts = parseConfigBoolean(rawValue);
    }
    if (key === "composerselectors") {
      config.composerSelectors = rawValue;
    }
    if (key === "sendbuttonselectors") {
      config.sendButtonSelectors = rawValue;
    }
    if (key === "scopedstreamingselectors") {
      config.scopedStreamingSelectors = rawValue;
    }
    if (key === "pagestreamingselectors") {
      config.pageStreamingSelectors = rawValue;
    }
    if (key === "stopbuttonselectors") {
      config.stopButtonSelectors = rawValue;
    }
    if (key === "assistantmessageselectors") {
      config.assistantMessageSelectors = rawValue;
    }
  });

  config.imagePromptsPerSection = IMAGE_PROMPTS_PER_CHAPTER;
  return config;
}

function parseDriveFolderConfig(value) {
  const text = String(value || "").trim().replace(/^["']|["']$/g, "");
  const result = {
    id: "",
    resourceKey: ""
  };
  if (!text) return result;

  const folderMatch = text.match(/\/folders\/([A-Za-z0-9_-]+)/);
  const idParamMatch = text.match(/[?&]id=([A-Za-z0-9_-]+)/);
  result.id = folderMatch
    ? folderMatch[1]
    : (idParamMatch ? idParamMatch[1] : text);

  const resourceKeyMatch = text.match(/[?&]resourcekey=([^&#]+)/i);
  if (resourceKeyMatch) {
    result.resourceKey = decodeURIComponent(resourceKeyMatch[1]);
  }

  return result;
}

function parseConfigBoolean(value) {
  const normalized = normalizeSheetName(value);
  return normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "on" ||
    normalized === "bat" ||
    normalized === "co";
}

function mapJobStatusToTopicStatus(jobStatus, jobStage, currentStatus) {
  const status = String(jobStatus || "").trim();
  const stage = String(jobStage || "").trim();

  if (status === JOB_STATUS_DONE || stage === JOB_STAGE_DONE) return STATUS_DONE_VI;
  if (status === JOB_STATUS_ERROR) return STATUS_ERROR_VI;
  if (status === JOB_STATUS_IMAGING || stage === JOB_STAGE_IMAGE) return STATUS_IMAGING;
  if (status === JOB_STATUS_SCRIPT_SAVED) return STATUS_SCRIPT_SAVED;
  if (status === JOB_STATUS_SCRIPTING || status === JOB_STATUS_CLAIMED || stage === JOB_STAGE_SCRIPT) return STATUS_WRITING;

  return currentStatus || STATUS_WRITING;
}

function buildJobWarning(data) {
  if (!data) return undefined;
  if (data.error) return String(data.error).slice(0, 500);
  if (data.currentSection) {
    return "Tiến độ chương " + data.currentSection;
  }
  return "";
}

function buildProgressNote(label, runId) {
  const time = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
  const cleanRunId = String(runId || "").trim();
  return label + " lúc " + time + (cleanRunId ? " | run " + cleanRunId.slice(-8) : "");
}

function detectExpectedStoryChapterCount(promptText) {
  const normalized = normalizeSheetName(promptText);
  const sectionWords = "(?:chuong|chapter|chapters|section|sections|part|parts|phan|doan)";
  const numberedWords = "(?:numbered\\s+)?";
  const commandWords = "(?:write|viet|tao|create|generate|deliver|compose|produce|chia\\s+thanh|split\\s+into|divide\\s+into|divided\\s+into|gom|include|can|need|tong\\s+cong|total(?:ly)?|number\\s+of|so\\s+luong)";
  const exactWords = "(?:exactly|dung|du|day\\s+du|chinh\\s+xac)";
  const patterns = [
    new RegExp("\\b" + commandWords + "\\b(?:\\s+\\w+){0,6}?\\s+(?:" + exactWords + "\\s+)?(\\d{1,3})\\s+" + numberedWords + sectionWords + "\\b", "g"),
    new RegExp("\\b(?:" + exactWords + "\\s+)(\\d{1,3})\\s+" + sectionWords + "\\b", "g"),
    new RegExp("\\b(\\d{1,3})\\s+" + numberedWords + sectionWords + "\\b", "g"),
    new RegExp("\\b(\\d{1,3})\\s*[-\u2013\u2014]\\s*(?:section|chapter|part)\\s+(?:story|script|narrative|outline|article)\\b", "g"),
    new RegExp("\\b(?:start|begin|bat\\s+dau)\\s+(?:with\\s+)?(?:section|part|chapter|chap|chuong|phan|doan)\\s+\\d{1,3}\\s*(?:/|of|tren|trong)\\s*(\\d{1,3})\\b", "g")
  ];
  let expected = 0;

  patterns.forEach(function (pattern) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      const value = Number(match[1]);
      if (value > expected && value <= MAX_STORY_CHAPTER_COUNT) expected = value;
      if (match.index === pattern.lastIndex) pattern.lastIndex++;
    }
  });

  return expected;
}

function buildChapterWarning(rawCount, cleanedCount, expectedCount) {
  const maxCount = Math.max(rawCount || 0, cleanedCount || 0);
  const expected = normalizeStoryChapterCount(expectedCount, DEFAULT_STORY_CHAPTER_COUNT);
  if (maxCount === expected) return "";
  if (maxCount > expected) {
    return "Nhận " + maxCount + " chương, đã ghi " + expected + " chương đầu.";
  }
  return "Mới nhận " + maxCount + "/" + expected + " chương.";
}

function isClaimableStatus(status) {
  const kind = getStatusKind(status);
  return kind === "blank" || kind === "not_started" || kind === "error";
}

function isActiveStatus(status) {
  const kind = getStatusKind(status);
  return kind === "writing" || kind === "script_saved" || kind === "imaging";
}

function getStatusKind(status) {
  const normalized = normalizeSheetName(status);
  if (!normalized) return "blank";
  if (normalized === "chua lam" || normalized === "todo" || normalized === "new") return "not_started";
  if (normalized === "dang viet" || normalized === "dang xu ly" || normalized === "processing" ||
      normalized === "claimed" || normalized === "scripting") return "writing";
  if (normalized === "da luu truyen" || normalized === "script_saved" || normalized === "script done") return "script_saved";
  if (normalized === "dang tao prompt anh" || normalized === "imaging" ||
      normalized === "generate_image_prompts") return "imaging";
  if (normalized === "da xong" || normalized === "hoan thanh" || normalized === "done") return "done";
  if (normalized === "loi" || normalized === "error") return "error";
  return "other";
}

function splitScriptIntoParagraphs(scriptText, config) {
  let paragraphs = [];
  const mode = config.scriptSplitMode || "auto";

  if (mode === "heading" || mode === "auto") {
    paragraphs = splitByHeadings(scriptText);
  }

  if (!paragraphs.length && (mode === "blank" || mode === "auto")) {
    paragraphs = String(scriptText || "")
      .split(/\n\s*\n+/)
      .map(function (part) { return part.trim(); })
      .filter(Boolean);
  }

  if (!paragraphs.length && (mode === "line" || mode === "auto")) {
    paragraphs = String(scriptText || "")
      .split(/\n+/)
      .map(function (part) { return part.trim(); })
      .filter(Boolean);
  }

  if (config.minParagraphLength > 0) {
    paragraphs = paragraphs.filter(function (part) {
      return part.length >= config.minParagraphLength;
    });
  }

  return paragraphs;
}

function splitByHeadings(scriptText) {
  const lines = String(scriptText || "").split(/\r?\n/);
  const parts = [];
  let current = [];
  let headingCount = 0;

  lines.forEach(function (line) {
    if (isLikelyHeading(line)) {
      headingCount++;
      if (current.length && hasNonMetadataContent(current)) {
        parts.push(current.join("\n").trim());
        current = [];
      } else if (current.length) {
        current = [];
      }
    }
    current.push(line);
  });

  if (current.length && hasNonMetadataContent(current)) {
    parts.push(current.join("\n").trim());
  }

  return headingCount >= 2 ? parts.filter(Boolean) : [];
}

function hasNonMetadataContent(lines) {
  return (lines || []).some(function (line) {
    const cleanedLine = String(line || "").trim();
    return cleanedLine && !isScriptMetadataLine(cleanedLine);
  });
}

function isLikelyHeading(line) {
  const normalized = removeDiacritics(String(line || "").trim().toLowerCase());
  if (!normalized) return false;

  return /^(#{1,3}\s*)?(\[\[)?(part|chapter|chap|chuong|section|phan|doan)\s*\d+/.test(normalized) ||
    /^\d+[\.\)]\s+/.test(normalized);
}

function cleanScriptParagraphRows(paragraphs, config) {
  const cleanMode = (config && config.scriptCleanMode) || "story";
  return (paragraphs || [])
    .map(function (paragraph) {
      return cleanMode === "none"
        ? normalizeScriptParagraph(paragraph)
        : cleanScriptParagraph(paragraph);
    });
}

function cleanScriptParagraph(paragraph) {
  const lines = String(paragraph || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const keptLines = [];

  lines.forEach(function (line) {
    const cleanedLine = line.trim();
    if (!cleanedLine) {
      keptLines.push("");
      return;
    }

    if (isScriptMetadataLine(cleanedLine)) return;
    keptLines.push(cleanedLine);
  });

  return normalizeScriptParagraph(keptLines.join("\n"));
}

function normalizeScriptParagraph(paragraph) {
  return String(paragraph || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(function (line) { return line.trim(); })
    .filter(Boolean)
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function isScriptMetadataLine(line) {
  const text = String(line || "").trim();
  let normalized = removeDiacritics(text.toLowerCase())
    .replace(/\*\*/g, "")
    .replace(/[`_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return true;
  normalized = normalized.replace(/^\[\s*/, "").replace(/\s*\]$/, "").trim();

  const patterns = [
    /^\[auto_pilot_(section|chuong|final_continue|ket_thuc)\b/,
    /^(#{1,6}\s*)?(section|part|chapter|chap|chuong|phan|doan)\s*#?\s*\d{1,3}(?:\s*(?:of|\/)\s*\d{1,3})?\s*[:.\-\)]?\s*$/,
    /^(#{1,6}\s*)?(section|part|chapter|chap|chuong|phan|doan)\s*#?\s*\d{1,3}(?:\s*(?:of|\/)\s*\d{1,3})?\s*[:.\-\)]\s+.{0,120}$/,
    /^(approx(?:imate|imately)?\s*)?(word\s*count|words?)\s*[:.\-\)]?\s*(about\s*)?\d[\d,.\s]*(?:\s*words?)?\.?$/,
    /^(\(?\s*)?(approx(?:imate|imately)?\s*)?\d[\d,.\s]*\s*words?\s*(\)?\s*)?\.?$/,
    /^(so tu|số từ|word count)\s*[:.\-\)]?\s*[\d,.]+\.?$/i,
    /^(please\s*)?(send|type|say|enter|reply(?:\s+with)?)\s+["'\u201c\u201d]?continue["'\u201c\u201d]?/i,
    /^(awaiting|waiting\s+for|ready\s+for|standing\s+by\s+for)\s+["'\u201c\u201d]?continue["'\u201c\u201d]?/i,
    /^(cho lenh|chờ lệnh|doi lenh|đợi lệnh|dang cho lenh|đang chờ lệnh)\s+["'\u201c\u201d]?(continue|viet tiep|viết tiếp|tiep tuc|tiếp tục)["'\u201c\u201d]?\.?$/i,
    /^(continue|viet tiep|viết tiếp|tiep tuc|tiếp tục)\s*$/i,
    /^continue\s*(?:to|for|with|the|part|section|phan|doan|final|ending|conclusion|wind[-\s]?down|wrap[-\s]?up)?\s*\.?$/i,
    /^het truyen\.?$/i,
    /^hết truyện\.?$/i,
    /^end of script\.\s*sweet dreams\.?$/i
  ];

  return patterns.some(function (pattern) {
    return pattern.test(normalized);
  });
}

function cleanImagePrompt(prompt, config) {
  let text = String(prompt || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return "";

  if (config.imagePromptCleanMode === "last_paragraph") {
    const parts = text.split(/\n\s*\n+/).map(function (part) { return part.trim(); }).filter(Boolean);
    if (parts.length) text = parts[parts.length - 1];
  }

  text = normalizeImagePromptBlock(text);
  if (!text) return "";
  if (isImagePromptNoise(text)) return "";

  if (config.imagePromptCleanMode === "strip_label") {
    text = text.replace(/^(\*\*)?\s*((image\s+)?prompt|prompt\s+(anh|ảnh))\s*(\*\*)?\s*[:\-\u2013]\s*/i, "");
  }

  return text.trim();
}

function splitImagePromptResponse(response) {
  const text = String(response || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return [];

  const sectionNumberedBlocks = splitBySectionPromptNumberLines(text);
  if (sectionNumberedBlocks.length >= 2) {
    return sectionNumberedBlocks;
  }

  const labelledBlocks = splitByPromptLabelLines(text);
  if (labelledBlocks.length >= 2) {
    return labelledBlocks;
  }

  const listBlocks = splitByNumberedOrBulletedLines(text);
  if (listBlocks.length >= 2) {
    return listBlocks;
  }

  const inlineBlocks = splitInlineNumberedImagePrompts(text);
  if (inlineBlocks.length >= 2) {
    return inlineBlocks;
  }

  const paragraphParts = text
    .split(/\n\s*\n+/)
    .map(function (part) { return normalizeImagePromptBlock(part); })
    .filter(Boolean);

  if (paragraphParts.length >= 2 && paragraphParts.length <= 10) {
    return paragraphParts;
  }

  return [normalizeImagePromptBlock(text)];
}

function splitBySectionPromptNumberLines(text) {
  const lines = String(text || "").split("\n");
  const markerPattern = /^\s*\d{1,3}\.\d{1,2}\s*(?:[:.\-\u2013\u2014\)]\s*)?/;
  const markerCount = lines.filter(function (line) {
    return markerPattern.test(line);
  }).length;

  if (markerCount < 2 || markerCount > MAX_IMAGE_PROMPTS_PER_RESPONSE) return [];

  const blocks = [];
  let current = null;

  lines.forEach(function (line) {
    if (markerPattern.test(line)) {
      if (current && current.join("").trim()) {
        blocks.push(current.join("\n"));
      }

      current = [line.replace(markerPattern, "").trim()];
      return;
    }

    if (current) current.push(line);
  });

  if (current && current.join("").trim()) {
    blocks.push(current.join("\n"));
  }

  return mergeImagePromptTitleBlocks(blocks).map(function (block) {
    return normalizeImagePromptBlock(block);
  }).filter(Boolean);
}

function splitByPromptLabelLines(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let current = null;

  lines.forEach(function (line) {
    if (isPromptLabelLine(line)) {
      if (current && current.join("").trim()) {
        blocks.push(current.join("\n"));
      }

      current = [];
      const remainder = stripPromptLabel(line);
      if (remainder) current.push(remainder);
      return;
    }

    if (current) current.push(line);
  });

  if (current && current.join("").trim()) {
    blocks.push(current.join("\n"));
  }

  return mergeImagePromptTitleBlocks(blocks).map(function (block) {
    return normalizeImagePromptBlock(block);
  }).filter(Boolean);
}

function splitByNumberedOrBulletedLines(text) {
  const lines = String(text || "").split("\n");
  const markerPattern = /^\s*(?:\d+(?:[\.\)]|\s+)|[-*]\s+)(?!\*)/;
  const markerCount = lines.filter(function (line) {
    return markerPattern.test(line);
  }).length;

  if (markerCount < 2 || markerCount > MAX_IMAGE_PROMPTS_PER_RESPONSE) return [];

  const blocks = [];
  let current = null;

  lines.forEach(function (line) {
    if (markerPattern.test(line)) {
      if (current && current.join("").trim()) {
        blocks.push(current.join("\n"));
      }

      current = [line.replace(markerPattern, "").trim()];
      return;
    }

    if (current) current.push(line);
  });

  if (current && current.join("").trim()) {
    blocks.push(current.join("\n"));
  }

  return mergeImagePromptTitleBlocks(blocks).map(function (block) {
    return normalizeImagePromptBlock(block);
  }).filter(Boolean);
}

function splitInlineNumberedImagePrompts(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const markerPattern = /(?:^|\s)(?:prompt\s*)?#?\d{1,3}[\.\):]\s+/gi;
  const matches = [];
  let match;

  while ((match = markerPattern.exec(normalized)) !== null) {
    matches.push({
      index: match.index,
      text: match[0]
    });
  }

  if (matches.length < 2 || matches.length > MAX_IMAGE_PROMPTS_PER_RESPONSE) return [];

  return matches.map(function (item, index) {
    const start = item.index + item.text.length;
    const end = index + 1 < matches.length ? matches[index + 1].index : normalized.length;
    return normalized.slice(start, end).trim();
  }).filter(Boolean);
}

function isPromptLabelLine(line) {
  const normalized = removeDiacritics(String(line || "").toLowerCase());
  return /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*((image\s+)?prompt|prompt\s+anh)\s*#?\s*\d+\s*(?:[:\.\-\)]|\*\*|$)/i.test(normalized);
}

function stripPromptLabel(line) {
  return String(line || "")
    .replace(/^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?\s*((image\s+)?prompt|prompt\s+(anh|ảnh))\s*#?\s*\d+\s*(?:[:\.\-\)\*\s])*/i, "")
    .replace(/^\s*\*\*/, "")
    .replace(/\*\*\s*$/, "")
    .trim();
}

function mergeImagePromptTitleBlocks(blocks) {
  const merged = [];
  for (let i = 0; i < blocks.length; i++) {
    const current = String(blocks[i] || "").trim();
    const next = String(blocks[i + 1] || "").trim();

    if (next && isLikelyImagePromptTitle(current, next)) {
      merged.push(current + "\n" + next);
      i++;
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function isGeneratedImagePromptHeading(text) {
  const normalized = removeDiacritics(String(text || "")
    .replace(/\*\*/g, "")
    .trim()
    .toLowerCase())
    .replace(/^\s*(?:#{1,6}\s*)?/, "")
    .replace(/^\s*[-*\u2013\u2014]\s*/, "")
    .replace(/\s+/g, " ");

  if (!normalized || normalized.length > 180) return false;
  return /\b(?:prompts?|prompt\s+(?:anh|image))\s*:$/.test(normalized);
}

function isImagePromptNoise(text) {
  const normalized = removeDiacritics(String(text || "").trim().toLowerCase())
    .replace(/\s+/g, " ");
  if (!normalized) return true;
  if (isGeneratedImagePromptHeading(normalized)) return true;

  const patterns = [
    /^van ban da dan(?:\s*\(\d+\))?(?:\.txt)?$/,
    /^pasted text(?:\s*\(\d+\))?(?:\.txt)?$/,
    /^text pasted(?:\s*\(\d+\))?(?:\.txt)?$/,
    /^tai lieu$/,
    /^document$/,
    /^uploaded (?:file|document)/,
    /^here are\s+\d+\s+.*image.*prompts?/,
    /^here are\s+.*prompts?\s+for\s+section/,
    /^duoi day la\s+\d+\s+.*prompt/,
    /^sau day la\s+\d+\s+.*prompt/,
    /^cac\s+prompt/,
    /^(?:section|phan|doan)\s+\d+$/
  ];

  return patterns.some(function (pattern) {
    return pattern.test(normalized);
  });
}

function normalizeImagePromptBlock(block) {
  let text = String(block || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return "";

  text = stripPromptLabel(text)
    .replace(/^\s*\*\*/, "")
    .replace(/\*\*\s*$/, "")
    .trim();

  const lines = text
    .split("\n")
    .map(function (line) {
      return line.replace(/^\s*\*\*/, "").replace(/\*\*\s*$/, "").trim();
    })
    .filter(Boolean);

  if (lines.length > 1 && isLikelyImagePromptTitle(lines[0], lines.slice(1).join(" "))) {
    const title = lines[0].trim();
    const desc = lines.slice(1).join(" ");
    text = title + (/[.\?!:]$/.test(title) ? " " : ". ") + desc;
  } else {
    const parts = text
      .split(/\n\s*\n+/)
      .map(function (part) {
        return part.replace(/^\s*\*\*/, "").replace(/\*\*\s*$/, "").trim();
      })
      .filter(Boolean);

    if (parts.length > 1 && isLikelyImagePromptTitle(parts[0], parts.slice(1).join(" "))) {
      const title = parts[0].trim();
      const desc = parts.slice(1).join(" ");
      text = title + (/[.\?!:]$/.test(title) ? " " : ". ") + desc;
    } else {
      text = parts.join(" ");
    }
  }

  return text.replace(/\s+/g, " ").trim();
}

function isLikelyImagePromptTitle(title, nextText) {
  const cleanTitle = String(title || "").replace(/\*\*/g, "").trim();
  const cleanNext = String(nextText || "").trim();
  const wordCount = cleanTitle ? cleanTitle.split(/\s+/).length : 0;

  return cleanTitle.length <= 90 &&
    wordCount > 0 &&
    wordCount <= 14 &&
    cleanNext.length >= 80 &&
    cleanNext.indexOf(",") !== -1 &&
    !/[\,\.;:]$/.test(cleanTitle);
}

function isLikelyImagePromptTitleOnly(text) {
  const cleaned = String(text || "")
    .replace(/^\s*[-\u2013\u2014]\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
  if (!cleaned) return true;
  if (isGeneratedImagePromptHeading(cleaned)) return true;

  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  return cleaned.length <= 90 &&
    wordCount > 0 &&
    wordCount <= 14 &&
    cleaned.indexOf(",") === -1 &&
    !/[.;:]$/.test(cleaned);
}

function getWorkingSheets(ss) {
  return ss.getSheets().filter(function (sheet) {
    return !isIgnoredSheetName(sheet.getName());
  });
}

function isIgnoredSheetName(name) {
  const normalized = normalizeSheetName(name);
  return IGNORED_SHEET_NAMES.indexOf(normalized) !== -1;
}

function getSheetByNameAny(ss, names) {
  for (let i = 0; i < names.length; i++) {
    const sheet = getSheetByNameNormalized(ss, names[i]);
    if (sheet) return sheet;
  }
  return null;
}

function getSheetByNameNormalized(ss, name) {
  const wanted = normalizeSheetName(name);
  const sheets = getWorkingSheets(ss);
  for (let i = 0; i < sheets.length; i++) {
    if (normalizeSheetName(sheets[i].getName()) === wanted) return sheets[i];
  }
  return null;
}

function getOrCreateSheet(ss, sheetName) {
  return getSheetByNameNormalized(ss, sheetName) || ss.insertSheet(sheetName);
}

function ensureRows(sheet, requiredRows) {
  const currentRows = sheet.getMaxRows();
  if (currentRows < requiredRows) {
    sheet.insertRowsAfter(currentRows, requiredRows - currentRows);
  }
}

function ensureColumns(sheet, requiredColumns) {
  const currentColumns = sheet.getMaxColumns();
  if (currentColumns < requiredColumns) {
    sheet.insertColumnsAfter(currentColumns, requiredColumns - currentColumns);
  }
}

function sanitizeSheetName(name) {
  return String(name || "")
    .replace(/[\*\?\/\\:\[\]]/g, "-")
    .trim()
    .substring(0, 50) || "kênh";
}

function stripImageTitlePrefix(value) {
  return String(value || "").replace(/^\s*prompt\s*(ảnh|anh)\s*-\s*/i, "").trim();
}

function isLikelyTopicHeader(topic) {
  const normalized = normalizeSheetName(topic);
  return normalized === "topic" ||
    normalized === "title" ||
    normalized === "tieu de" ||
    normalized === "chu de";
}

function normalizeTopicValue(value) {
  return removeDiacritics(String(value || ""))
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeSheetName(name) {
  return removeDiacritics(String(name || "").trim().toLowerCase()).replace(/\s+/g, " ");
}

function removeDiacritics(text) {
  return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d");
}

function createServerJobId() {
  return "job-" + Date.now() + "-" + Utilities.getUuid();
}

function isVietnameseText(text) {
  return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/.test(String(text || ""));
}
