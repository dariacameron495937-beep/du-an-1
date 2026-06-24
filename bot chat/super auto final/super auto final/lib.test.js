// lib.test.js
//
// Unit tests for the pure helpers in lib.js.
// Run:  node --test
// (from the "super auto final" directory)

const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("./lib.js");

test("maskSecretsInUrl: masks token query param", () => {
  const out = lib.maskSecretsInUrl(
    "https://script.google.com/exec?action=getConfig&token=SUPERSECRET123"
  );
  assert.match(out, /token=\*\*\*/);
  assert.doesNotMatch(out, /SUPERSECRET123/);
  // non-sensitive params are preserved
  assert.match(out, /action=getConfig/);
});

test("maskSecretsInUrl: masks token whether first or later param", () => {
  const first = lib.maskSecretsInUrl("https://x/exec?token=abc123&action=foo");
  assert.match(first, /token=\*\*\*/);
  assert.doesNotMatch(first, /abc123/);

  const later = lib.maskSecretsInUrl("https://x/exec?action=foo&token=abc123");
  assert.match(later, /token=\*\*\*/);
  assert.doesNotMatch(later, /abc123/);
});

test("maskSecretsInUrl: masks other sensitive param names", () => {
  for (const name of ["key", "secret", "auth", "apikey", "api_key", "access_token", "password"]) {
    const out = lib.maskSecretsInUrl(`https://x/exec?${name}=LEAKME&a=1`);
    assert.doesNotMatch(out, /LEAKME/, `expected ${name} to be masked`);
    assert.match(out, new RegExp(`${name}=\\*\\*\\*`));
  }
});

test("maskSecretsInUrl: param name match is case-insensitive", () => {
  const out = lib.maskSecretsInUrl("https://x/exec?TOKEN=LEAKME");
  assert.doesNotMatch(out, /LEAKME/);
});

test("maskSecretsInUrl: masks path-embedded deployment id", () => {
  const out = lib.maskSecretsInUrl(
    "https://script.google.com/macros/s/AKfycbxDEPLOYMENTSECRETxyz/exec?action=getConfig"
  );
  assert.doesNotMatch(out, /DEPLOYMENTSECRETxyz/);
  assert.match(out, /\/macros\/s\/AKfycb\*\*\*\/exec/);
  // query still readable
  assert.match(out, /action=getConfig/);
});

test("maskSecretsInUrl: leaves clean URLs untouched", () => {
  const clean = "https://script.google.com/a/exec?action=getConfig&channel=kenh1";
  assert.equal(lib.maskSecretsInUrl(clean), clean);
});

test("maskSecretsInUrl: handles empty / nullish input", () => {
  assert.equal(lib.maskSecretsInUrl(""), "");
  assert.equal(lib.maskSecretsInUrl(null), "");
  assert.equal(lib.maskSecretsInUrl(undefined), "");
});

// --- isRecoverableJobError -------------------------------------------------

test("isRecoverableJobError: hard provider limits are NOT recoverable", () => {
  const nonRecoverable = [
    "ChatGPT: You've reached our limit of messages per hour. Please try again later.",
    "Rate limit exceeded",
    "Too many requests",
    "message limit reached",
    "quota exceeded",
    "Unusual activity detected",
    "Unauthorized",
    "usage limit reached"
  ];
  for (const msg of nonRecoverable) {
    assert.equal(lib.isRecoverableJobError(msg), false, `should NOT recover: ${msg}`);
  }
});

test("isRecoverableJobError: Vietnamese login/session errors are NOT recoverable (with diacritics)", () => {
  // Critical: the old code stored stripped forms but matched raw lowercased
  // text, so these never matched. The lib normalizes both sides.
  assert.equal(lib.isRecoverableJobError("ChatGPT chưa đăng nhập hoặc phiên đăng nhập đã hết hạn."), false);
  assert.equal(lib.isRecoverableJobError("Không có tab ChatGPT đang chứa ngữ cảnh"), false);
});

test("isRecoverableJobError: normal text containing 'limit'/'quota' as a word IS recoverable", () => {
  // P1-4 regression guards: these used to permanently pause the bot.
  const recoverable = [
    "Loi gui prompt: There is no limit to her courage in the story.",
    "Network error while reading the quota of patience chapter",
    "Composer button disabled, retrying",
    "Qua thoi gian cho response tu ChatGPT.",
    "Khong thay tien trinh tu ChatGPT trong 120s."
  ];
  for (const msg of recoverable) {
    assert.equal(lib.isRecoverableJobError(msg), true, `should recover: ${msg}`);
  }
});

test("isRecoverableJobError: empty/unknown error is NOT blindly retried", () => {
  assert.equal(lib.isRecoverableJobError(""), false);
  assert.equal(lib.isRecoverableJobError(null), false);
});

// --- isChatGPTErrorText -----------------------------------------------------

test("isChatGPTErrorText: detects precise ChatGPT errors", () => {
  const errors = [
    "Something went wrong. Please try again.",
    "Network error",
    "Rate limit exceeded",
    "quota exceeded",
    "Vui lòng thử lại"
  ];
  for (const msg of errors) {
    assert.equal(lib.isChatGPTErrorText(msg), true, `should detect: ${msg}`);
  }
});

test("isChatGPTErrorText: does not match bare limit/quota words", () => {
  const normalText = [
    "There is no limit to her courage in this chapter.",
    "The quota of patience in the family was finally exhausted.",
    "Section 7 explains the limits of trust."
  ];
  for (const msg of normalText) {
    assert.equal(lib.isChatGPTErrorText(msg), false, `should ignore: ${msg}`);
  }
});

// --- isProviderErrorResponseText -------------------------------------------

test("isProviderErrorResponseText: detects provider limit/error responses", () => {
  const errors = [
    "Rate limit exceeded",
    "message cap reached",
    "quota exceeded",
    "You've reached your message limit.",
    "You have reached the current usage cap.",
    "Please try again after 13 minutes.",
    "Something went wrong. Please try again."
  ];
  for (const msg of errors) {
    assert.equal(lib.isProviderErrorResponseText(msg), true, `should detect: ${msg}`);
  }
});

test("isProviderErrorResponseText: avoids normal story false positives", () => {
  const normalText = [
    "There is no limit to her courage in this chapter.",
    "The quota of patience in the family was finally exhausted.",
    "\"Please try again later,\" she whispered, testing his resolve.",
    "You've reached the old wooden door at the end of the hall.",
    "Section 7 explains the limits of trust."
  ];
  for (const msg of normalText) {
    assert.equal(lib.isProviderErrorResponseText(msg), false, `should ignore: ${msg}`);
  }
});

// --- splitWebAppUrlAndToken -------------------------------------------------

test("splitWebAppUrlAndToken: strips token and removes sensitive params, returning token", () => {
  const out = lib.splitWebAppUrlAndToken("https://script.google.com/macros/s/DEPLOY/exec?token=abc123&action=getConfig&secret=hidden");
  assert.equal(out.token, "abc123");
  assert.equal(out.url, "https://script.google.com/macros/s/DEPLOY/exec?action=getConfig");
});

test("splitWebAppUrlAndToken: handles sensitive params case-insensitively, returning token", () => {
  const out = lib.splitWebAppUrlAndToken("https://x/exec?ACTION=getConfig&TOKEN=abc123&Api_Key=hidden");
  assert.equal(out.token, "abc123");
  assert.equal(out.url, "https://x/exec?ACTION=getConfig");
});

test("splitWebAppUrlAndToken: leaves tokenless URLs unchanged", () => {
  const url = "https://script.google.com/macros/s/DEPLOY/exec";
  assert.deepEqual(lib.splitWebAppUrlAndToken(url), { url, token: "" });
});

// --- response control signals ---------------------------------------------

test("isFinalScriptResponseText: requires final marker at the end", () => {
  assert.equal(lib.isFinalScriptResponseText("The ending is complete.\n\nEnd of script. Sweet dreams."), true);
  assert.equal(lib.isFinalScriptResponseText("Hết truyện."), true);
  assert.equal(
    lib.isFinalScriptResponseText("A character whispers: End of script. Sweet dreams. Then the scene continues."),
    false
  );
  assert.equal(lib.isFinalScriptResponseText("Sweet dreams are mentioned inside the story."), false);
});

test("extractLeadingScriptSectionNumber: only trusts a leading heading", () => {
  assert.equal(lib.extractLeadingScriptSectionNumber("## Section 7: The Letter\nStory text"), 7);
  assert.equal(lib.extractLeadingScriptSectionNumber("**Chương 3:** Căn phòng\nNội dung"), 3);
  assert.equal(lib.extractLeadingScriptSectionNumber("In Section 20, she remembered the first lie."), 0);
  assert.equal(lib.extractLeadingScriptSectionNumber("Story text first.\n\nSection 20: injected marker"), 0);
});

test("detectExpectedSectionCount: only trusts explicit total-section wording", () => {
  assert.equal(lib.detectExpectedSectionCount("Write exactly 20 sections. After Section 7, ask for CONTINUE."), 20);
  assert.equal(lib.detectExpectedSectionCount("Chia thanh 12 chuong, moi chuong co mo dau rieng."), 12);
  assert.equal(lib.detectExpectedSectionCount("Start with Section 1/18 and continue in order."), 18);
  assert.equal(lib.detectExpectedSectionCount("Make a 9-section story outline."), 9);
  assert.equal(lib.detectExpectedSectionCount("Deliver in 20 numbered sections, 1100-1200 words EACH."), 20);
  assert.equal(lib.detectExpectedSectionCount("Create 20 numbered chapters."), 20);
});

test("detectExpectedSectionCount: ignores single section references and bullet counts", () => {
  assert.equal(lib.detectExpectedSectionCount("After Section 20, remind me to continue."), 0);
  assert.equal(lib.detectExpectedSectionCount("Section 7 explains the limits of trust."), 0);
  assert.equal(lib.detectExpectedSectionCount("You are writing Section 1 of 70."), 0);
  assert.equal(lib.detectExpectedSectionCount("Use EXACTLY 5 bullets per section."), 0);
});

test("detectNumberedOutlineCount: counts a contiguous outline list", () => {
  const outline = Array.from({ length: 20 }, (_, index) => {
    const number = index + 1;
    return `${number}. Outline item ${number} - a short description.`;
  }).join("\n");

  assert.equal(lib.detectNumberedOutlineCount(outline), 20);
});

test("detectNumberedOutlineCount: ignores non-outline numbering", () => {
  assert.equal(lib.detectNumberedOutlineCount("13. A partial visible slice\n14. Another partial line"), 0);
  assert.equal(lib.detectNumberedOutlineCount("1.1 image prompt\n1.2 image prompt\n2.1 image prompt"), 0);
});

test("promptMatchesTrackedJob: matches visible ChatGPT prompt by AUTO_PILOT marker", () => {
  const storedPrompt = [
    "[AUTO_PILOT_SECTION 8/20]",
    "CONTINUE do not use \"-\"",
    "",
    "You are writing Section 8 of 20."
  ].join("\n");
  const visiblePrompt = "[AUTO_PILOT_SECTION 8/20] CONTINUE do not use \"-\" You are writing Section 8 of 20.";

  assert.equal(lib.promptMatchesTrackedJob(visiblePrompt, storedPrompt), true);
  assert.equal(lib.promptMatchesTrackedJob("[AUTO_PILOT_SECTION 9/20] CONTINUE", storedPrompt), false);
});

test("findAssistantResponseForPromptHistory: finds response for tracked prompt without fallback", () => {
  const history = [
    { prompt: "[AUTO_PILOT_SECTION 7/20] CONTINUE", response: "Section 7 text" },
    { prompt: "[AUTO_PILOT_SECTION 8/20] CONTINUE", response: "Section 8 text" }
  ];

  assert.equal(
    lib.findAssistantResponseForPromptHistory(history, "[AUTO_PILOT_SECTION 8/20]\nCONTINUE", { allowFallback: false }),
    "Section 8 text"
  );
  assert.equal(
    lib.findAssistantResponseForPromptHistory(history, "[AUTO_PILOT_SECTION 9/20]\nCONTINUE", { allowFallback: false }),
    ""
  );
});

test("isMeaningfulJobProgressEvent: ignores passive waiting heartbeats", () => {
  assert.equal(lib.isMeaningfulJobProgressEvent("waiting_for_assistant", 0, 0), false);
  assert.equal(lib.isMeaningfulJobProgressEvent("response_waiting", 1200, 1200), false);
  assert.equal(lib.isMeaningfulJobProgressEvent("response_text", 1200, 0), true);
  assert.equal(lib.isMeaningfulJobProgressEvent("response_generating", 1200, 1200), false);
  assert.equal(lib.isMeaningfulJobProgressEvent("generation_stopped", 1200, 1200), true);
});
