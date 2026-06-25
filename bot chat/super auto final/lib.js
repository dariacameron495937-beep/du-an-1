// lib.js
//
// Pure, side-effect-free helpers shared between the background service worker
// and the Node unit tests. No DOM, no chrome.*, no fetch — only string logic.
//
// Loading model (no build step):
//   - Service worker: include via importScripts("lib.js") BEFORE background.js;
//     helpers are attached to globalThis.AutoPilotLib.
//   - Node tests: require("./lib.js") returns the helpers via module.exports.

(function (root, factory) {
  const api = factory();
  // Node / CommonJS
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  // Service worker / browser global
  if (root) {
    root.AutoPilotLib = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // --- Secret masking -------------------------------------------------------
  //
  // The Web App URL frequently carries a deployment secret either as a query
  // parameter (token=..., key=..., auth=..., secret=...) or embedded in the
  // /macros/s/<DEPLOYMENT_ID>/exec path. We must never write the raw secret to
  // the persistent log. This masks all known-sensitive forms.

  const SENSITIVE_PARAM_NAMES = [
    "token",
    "key",
    "secret",
    "auth",
    "password",
    "pwd",
    "apikey",
    "api_key",
    "access_token"
  ];

  function maskSecretsInUrl(rawUrl) {
    let url = String(rawUrl == null ? "" : rawUrl);
    if (!url) return url;

    // 1) Mask sensitive query parameters (case-insensitive name match).
    //    Matches `name=value` up to the next & or end of string.
    const paramAlternation = SENSITIVE_PARAM_NAMES.join("|");
    const paramRegex = new RegExp(
      "([?&](?:" + paramAlternation + ")=)[^&#]*",
      "gi"
    );
    url = url.replace(paramRegex, "$1***");

    // 2) Mask the Apps Script deployment id embedded in the path:
    //    https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec
    //    The id itself is a deployment secret; show only a short prefix.
    url = url.replace(
      /(\/macros\/s\/)([^/]{0,6})[^/]*(\/)/g,
      function (_match, pre, head, post) {
        return pre + head + "***" + post;
      }
    );

    return url;
  }

  // --- Recoverable error classification ------------------------------------
  //
  // A job error is NON-recoverable (pause the bot, require human attention)
  // when it indicates auth/login problems or a hard provider limit/quota.
  // Everything else is treated as transient and retried.
  //
  // P1-4: the previous implementation matched the bare substrings "limit" and
  // "quota" anywhere in the text, which permanently paused the bot whenever a
  // normal message merely contained those words. We now use precise patterns.

  const NON_RECOVERABLE_PATTERNS = [
    /\bmessage limit\b/,
    /\brate limit(?:ed|ing)?\b/,
    /\btoo many requests\b/,
    /\bunusual activity\b/,
    /\bunauthorized\b/,
    /\bmessage cap\b/,
    /\bquota exceeded\b/,
    /\bexceeded your quota\b/,
    /\busage limit\b/,
    /\byou'?ve reached\b/,            // "you've reached your limit/cap"
    /\breached the limit\b/,
    /\breached your limit\b/,
    /\btry again (?:after|later)\b/,
    // Vietnamese login/session phrases (diacritics removed before matching)
    /chua dang nhap/,
    /phien dang nhap/,
    /khong co tab chatgpt dang chua ngu canh/,
    /khong the gui continue vao chat trong/
  ];

  const CHATGPT_TRANSIENT_ERROR_PATTERNS = [
    /\bsomething went wrong\b/,
    /\berror generating\b/,
    /\bplease try again\b/,
    /\bnetwork error\b/,
    /\blost connection\b/,
    /\bfailed to fetch\b/,
    /loi mang/,
    /vui long thu lai/,
    /khong the tao/
  ];

  const PROVIDER_RESPONSE_ERROR_PATTERNS = [
    /\btoo many requests\b/,
    /\brate limit(?:ed|ing)?(?:\s+(?:reached|exceeded))?\b/,
    /\bmessage (?:limit|cap)\b/,
    /\busage limit\b/,
    /\bquota exceeded\b/,
    /\bexceeded your quota\b/,
    /\b(?:you'?ve|you have) reached (?:the |your |our )?(?:current )?(?:(?:message|usage|rate)\s+)?(?:limit|cap|quota)\b/,
    /\b(?:try again|retry) (?:in|after) \d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/
  ];

  const SHORT_PROVIDER_RESPONSE_ERROR_PATTERNS = [
    /^something went wrong\.?(?: please try again\.?)?$/,
    /^error generating(?: response)?\.?$/,
    /^network error\.?$/,
    /^please try again later\.?$/,
    /^please try again after [^.]+\.?$/
  ];

  const DEFAULT_MAX_EXPECTED_SECTIONS = 300;

  // Mirrors normalizeCommandText in background.js: strip diacritics, collapse
  // whitespace, lowercase. Kept here so classification is self-contained.
  function normalizeForMatch(value) {
    return String(value == null ? "" : value)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[đĐ]/g, "d") // đ Đ
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function normalizeMaxExpectedSectionCount(maxCount) {
    const max = Number(maxCount);
    return Number.isFinite(max) && max > 0
      ? Math.floor(max)
      : DEFAULT_MAX_EXPECTED_SECTIONS;
  }

  function extractTrackedPromptMarker(value) {
    const match = String(value == null ? "" : value)
      .match(/\[AUTO_PILOT_(?:SECTION|CHUONG|FINAL_CONTINUE|KET_THUC)\s+[^\]]+\]/i);
    return match ? normalizeForMatch(match[0]) : "";
  }

  function promptMatchesTrackedJob(candidatePrompt, targetPrompt) {
    const candidate = normalizeForMatch(candidatePrompt);
    const target = normalizeForMatch(targetPrompt);
    if (candidate && target && candidate === target) return true;

    const marker = extractTrackedPromptMarker(targetPrompt);
    return Boolean(marker && candidate.includes(marker));
  }

  function findAssistantResponseForPromptHistory(history, promptText, options) {
    const items = Array.isArray(history) ? history : [];
    if (!items.length) return "";

    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i] || {};
      if (promptMatchesTrackedJob(item.prompt, promptText)) {
        return String(item.response || "").trim();
      }
    }

    if (options && options.allowFallback === false) return "";

    const latest = items[items.length - 1] || {};
    return String(latest.response || "").trim();
  }

  function isMeaningfulJobProgressEvent(event, textLength, previousTextLength) {
    const name = String(event || "");
    const currentLength = Number(textLength) || 0;
    const priorLength = Number(previousTextLength) || 0;

    if (
      name === "response_text" ||
      name === "response_generating" ||
      name === "sync_generating_text"
    ) {
      return currentLength > priorLength;
    }

    return [
      "queued",
      "composer_ready",
      "prompt_sent",
      "assistant_started",
      "generation_stopped"
    ].indexOf(name) !== -1;
  }

  function collectExpectedSectionCountMatches(text, patterns, maxCount) {
    let expected = 0;

    patterns.forEach(function (pattern) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value > expected && value <= maxCount) {
          expected = value;
        }

        if (match.index === pattern.lastIndex) {
          pattern.lastIndex++;
        }
      }
    });

    return expected;
  }

  function detectExpectedSectionCount(value, maxCount) {
    const text = normalizeForMatch(value);
    if (!text) return 0;

    const max = normalizeMaxExpectedSectionCount(maxCount);
    const sectionWords = "(?:chuong|chapter|chapters|section|sections|part|parts|phan|doan)";
    const numberedWords = "(?:numbered\\s+)?";
    const commandWords = "(?:write|viet|tao|create|generate|deliver|compose|produce|chia\\s+thanh|split\\s+into|divide\\s+into|divided\\s+into|gom|include|can|need|tong\\s+cong|total(?:ly)?|number\\s+of|so\\s+luong)";
    const exactWords = "(?:exactly|dung|du|day\\s+du|chinh\\s+xac)";

    const patterns = [
      new RegExp("\\b" + commandWords + "\\b(?:\\s+\\w+){0,6}?\\s+(?:" + exactWords + "\\s+)?(\\d{1,3})\\s+" + numberedWords + sectionWords + "\\b", "g"),
      new RegExp("\\b(?:" + exactWords + "\\s+)(\\d{1,3})\\s+" + sectionWords + "\\b", "g"),
      new RegExp("\\b(\\d{1,3})\\s*[-\u2013\u2014]\\s*(?:section|chapter|part)\\s+(?:story|script|narrative|outline|article)\\b", "g"),
      new RegExp("\\b(?:start|begin|bat\\s+dau)\\s+(?:with\\s+)?(?:section|part|chapter|chap|chuong|phan|doan)\\s+\\d{1,3}\\s*(?:/|of|tren|trong)\\s*(\\d{1,3})\\b", "g")
    ];

    return collectExpectedSectionCountMatches(text, patterns, max);
  }

  function detectNumberedOutlineCount(value, maxCount) {
    const max = normalizeMaxExpectedSectionCount(maxCount);
    const lines = String(value == null ? "" : value)
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const numbers = {};

    lines.forEach(function (line) {
      const raw = String(line || "").replace(/[*_`~]/g, "").trim();
      if (!raw) return;

      let match = raw.match(/^(?:[-*]\s*)?(?:#{1,6}\s*)?(\d{1,3})\s*[\.\)]\s+(?!\d)/);
      if (!match) {
        const normalized = normalizeForMatch(raw)
          .replace(/^[-*]\s*/, "")
          .replace(/^#{1,6}\s*/, "");
        match = normalized.match(/^(?:section|part|chapter|chap|chuong|phan|doan)\s*#?\s*(\d{1,3})\b/);
      }

      const number = match ? Number(match[1]) : 0;
      if (Number.isFinite(number) && number > 0 && number <= max) {
        numbers[number] = true;
      }
    });

    if (!numbers[1]) return 0;

    let count = 0;
    for (let number = 1; number <= max; number++) {
      if (!numbers[number]) break;
      count = number;
    }

    return count >= 2 ? count : 0;
  }

  function isRecoverableJobError(errorMessage) {
    const text = normalizeForMatch(errorMessage);
    if (!text) return false; // empty / unknown → don't blindly retry
    if (NON_RECOVERABLE_PATTERNS.some(function (re) { return re.test(text); })) {
      return false;
    }
    return true;
  }

  function isChatGPTErrorText(message) {
    const text = normalizeForMatch(message);
    if (!text) return false;
    return CHATGPT_TRANSIENT_ERROR_PATTERNS.some(function (re) { return re.test(text); }) ||
      NON_RECOVERABLE_PATTERNS.some(function (re) { return re.test(text); });
  }

  function isProviderErrorResponseText(message) {
    const text = normalizeForMatch(message);
    if (!text) return false;
    if (PROVIDER_RESPONSE_ERROR_PATTERNS.some(function (re) { return re.test(text); })) {
      return true;
    }
    return text.length <= 300 &&
      SHORT_PROVIDER_RESPONSE_ERROR_PATTERNS.some(function (re) { return re.test(text); });
  }

  function isFinalScriptResponseText(value) {
    const text = String(value == null ? "" : value)
      .replace(/[*_`~]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const normalized = normalizeForMatch(text);
    if (!normalized) return false;

    return /\bend of script\.\s*sweet dreams\.?$/i.test(text) ||
      /\bend of story\.?$/i.test(text) ||
      /\b(?:het kich ban|het truyen)\.?$/.test(normalized);
  }

  function parseScriptSectionHeadingLine(line, maxCount) {
    const raw = String(line || "").replace(/[*_`~]/g, "").trim();
    if (!raw) return 0;

    const normalized = normalizeForMatch(raw)
      .replace(/^[-*]\s*/, "")
      .replace(/^#{1,6}\s*/, "");
    const match = normalized.match(/^(?:section|part|chapter|chap|chuong|phan|doan)\s*#?\s*(\d{1,3})\b/);
    if (!match) return 0;

    const max = normalizeMaxExpectedSectionCount(maxCount);
    const sectionNumber = Number(match[1]);
    return Number.isFinite(sectionNumber) && sectionNumber > 0 && sectionNumber <= max
      ? sectionNumber
      : 0;
  }

  function collectScriptSectionHeadingMatches(line, maxCount) {
    const rawLine = String(line || "");
    const max = normalizeMaxExpectedSectionCount(maxCount);
    const matches = [];
    const leadingNumber = parseScriptSectionHeadingLine(rawLine, max);
    if (leadingNumber) {
      matches.push({ number: leadingNumber, index: 0 });
    }

    const inlineHeadingPattern = /(?:section|part|chapter|chap|chương|chuong|phần|phan|đoạn|doan)\s*#?\s*(\d{1,3})\s*[:\-–—]/giu;
    let match;
    while ((match = inlineHeadingPattern.exec(rawLine)) !== null) {
      const number = Number(match[1]);
      if (Number.isFinite(number) && number > 0 && number <= max) {
        const isDuplicate = matches.some(function (item) {
          return item.index === match.index || Math.abs(item.index - match.index) <= 3;
        });
        if (!isDuplicate) {
          matches.push({ number: number, index: match.index });
        }
      }

      if (match.index === inlineHeadingPattern.lastIndex) {
        inlineHeadingPattern.lastIndex++;
      }
    }

    return matches.sort(function (a, b) { return a.index - b.index; });
  }

  function extractLeadingScriptSectionNumber(value) {
    const lines = String(value == null ? "" : value)
      .replace(/\r\n?/g, "\n")
      .split("\n");

    for (let i = 0; i < Math.min(lines.length, 12); i++) {
      const line = String(lines[i] || "").trim();
      if (!line) continue;

      return parseScriptSectionHeadingLine(line, DEFAULT_MAX_EXPECTED_SECTIONS);
    }

    return 0;
  }

  function parseScriptSections(value, maxCount) {
    const max = normalizeMaxExpectedSectionCount(maxCount);
    const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    const headings = [];
    let offset = 0;

    lines.forEach(function (line, index) {
      collectScriptSectionHeadingMatches(line, max).forEach(function (heading) {
        headings.push({
          number: heading.number,
          lineIndex: index,
          offset: offset + heading.index
        });
      });
      offset += line.length + 1;
    });

    return headings.map(function (heading, index) {
      const nextHeading = headings[index + 1];
      const response = text
        .slice(heading.offset, nextHeading ? nextHeading.offset : text.length)
        .trim();
      return {
        number: heading.number,
        response: response
      };
    }).filter(function (item) {
      return item.response;
    });
  }

  function splitWebAppUrlAndToken(rawUrl) {
    const value = String(rawUrl == null ? "" : rawUrl).trim();
    if (!value) return { url: "", token: "" };

    try {
      const parsed = new URL(value);
      let token = "";
      const sensitiveParamMap = SENSITIVE_PARAM_NAMES.reduce(function (acc, name) {
        acc[name.toLowerCase()] = true;
        return acc;
      }, {});

      Array.from(parsed.searchParams.keys()).forEach(function (name) {
        const lowerName = String(name || "").toLowerCase();
        if (sensitiveParamMap[lowerName]) {
          if (lowerName === "token") {
            token = parsed.searchParams.get(name) || "";
          }
          parsed.searchParams.delete(name);
        }
      });
      return {
        url: parsed.toString(),
        token: token
      };
    } catch (_error) {
      return splitWebAppUrlAndTokenFallback(value);
    }
  }

  function splitWebAppUrlAndTokenFallback(value) {
    let url = String(value || "");
    let token = "";

    const match = url.match(/[?&]token=([^&#]*)/i);
    if (match) {
      token = match[1];
    }

    url = url.replace(/([?&])token=([^&#]*)/i, function (match, prefix) {
      return prefix === "?" ? "?" : "";
    });

    SENSITIVE_PARAM_NAMES.forEach(function (name) {
      if (name.toLowerCase() !== "token") {
        url = url.replace(new RegExp("([?&])" + name + "=([^&#]*)", "gi"), function (m, prefix) {
          return prefix === "?" ? "?" : "";
        });
      }
    });

    url = url
      .replace(/\?&/, "?")
      .replace(/[?&]$/, "");

    return { url: url, token: token };
  }

  return {
    SENSITIVE_PARAM_NAMES: SENSITIVE_PARAM_NAMES,
    NON_RECOVERABLE_PATTERNS: NON_RECOVERABLE_PATTERNS,
    CHATGPT_TRANSIENT_ERROR_PATTERNS: CHATGPT_TRANSIENT_ERROR_PATTERNS,
    maskSecretsInUrl: maskSecretsInUrl,
    normalizeForMatch: normalizeForMatch,
    extractTrackedPromptMarker: extractTrackedPromptMarker,
    promptMatchesTrackedJob: promptMatchesTrackedJob,
    findAssistantResponseForPromptHistory: findAssistantResponseForPromptHistory,
    isMeaningfulJobProgressEvent: isMeaningfulJobProgressEvent,
    isRecoverableJobError: isRecoverableJobError,
    isChatGPTErrorText: isChatGPTErrorText,
    isProviderErrorResponseText: isProviderErrorResponseText,
    isFinalScriptResponseText: isFinalScriptResponseText,
    detectExpectedSectionCount: detectExpectedSectionCount,
    detectNumberedOutlineCount: detectNumberedOutlineCount,
    parseScriptSectionHeadingLine: parseScriptSectionHeadingLine,
    extractLeadingScriptSectionNumber: extractLeadingScriptSectionNumber,
    parseScriptSections: parseScriptSections,
    splitWebAppUrlAndToken: splitWebAppUrlAndToken
  };
});
