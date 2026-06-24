const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = __dirname;
const LIB_SOURCE = fs.readFileSync(path.join(ROOT, "lib.js"), "utf8");
const BACKGROUND_SOURCE = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

function createChrome(storageState) {
  const event = () => ({ addListener() {}, removeListener() {} });

  return {
    runtime: {
      lastError: null,
      onInstalled: event(),
      onStartup: event(),
      onConnect: event(),
      onMessage: event()
    },
    storage: {
      local: {
        get(keys, callback) {
          if (keys == null) return callback({ ...storageState });
          const names = Array.isArray(keys) ? keys : [keys];
          callback(Object.fromEntries(names.map((key) => [key, storageState[key]])));
        },
        set(patch, callback = () => {}) {
          Object.assign(storageState, patch);
          callback();
        }
      }
    },
    alarms: {
      onAlarm: event(),
      create() {},
      clear(_name, callback = () => {}) { callback(true); }
    },
    tabs: {
      onUpdated: event(),
      query(_query, callback) {
        if (callback) return callback([]);
        return Promise.resolve([]);
      },
      sendMessage(_id, _message, callback) {
        if (callback) return callback({ status: "started" });
        return Promise.resolve({ status: "started" });
      }
    }
  };
}

function loadBackground(storageState, sentPrompts, saveCalls) {
  const chrome = createChrome(storageState);
  const context = {
    chrome,
    console,
    crypto: { randomUUID: () => `uuid-${sentPrompts.length + 1}` },
    fetch: async (_url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      if (body.action === "saveScript") saveCalls.push(body);
      return { ok: true, json: async () => ({ ok: true }) };
    },
    importScripts() {},
    setTimeout,
    clearTimeout,
    URL,
    AbortController
  };
  context.globalThis = context;

  vm.runInNewContext(`${LIB_SOURCE}\nglobalThis.AutoPilotLib = AutoPilotLib;`, context);
  vm.runInNewContext(`${BACKGROUND_SOURCE}\n
    globalThis.__workflowTest = {
      handleResponseComplete,
      handleStart,
      handlePause,
      handleStop,
      runWorkflowStep,
      runSheetWorkflowStep,
      resumeRunningWorkflowAfterWake,
      setRequestWorkflowRun(fn) { requestWorkflowRun = fn; },
      setSendToChatGPT(fn) { sendToChatGPT = fn; }
    };
  `, context);

  context.__workflowTest.setRequestWorkflowRun(() => {});
  context.__workflowTest.setSendToChatGPT(async (prompt, options) => {
    sentPrompts.push({ prompt, options });
  });
  return context.__workflowTest;
}

function firstResponseState(overrides = {}) {
  return {
    status: "running",
    sheetWorkflowState: "WAITING_FOR_SCRIPT",
    currentTopic: "Topic A",
    selectedChannel: "Channel A",
    currentChannel: "Channel A",
    currentRow: 2,
    config: { scriptContinuePrompt: "TIẾP TỤC THEO CẤU HÌNH" },
    activeJobId: "first-job",
    activeJobStage: "script_outline",
    activeJobStartedAt: Date.now(),
    scriptOutline: "",
    scriptSections: [],
    scriptSectionNumbers: [],
    scriptSectionIndex: 1,
    scriptExpectedSections: 3,
    scriptFinalContinueAttempts: 0,
    scriptLastDiversitySection: 0,
    ...overrides
  };
}

async function receiveFirstResponse(response, overrides = {}, responseMetadata = {}) {
  const state = firstResponseState(overrides);
  const sentPrompts = [];
  const saveCalls = [];
  const api = loadBackground(state, sentPrompts, saveCalls);
  await api.handleResponseComplete({ jobId: "first-job", response, ...responseMetadata });
  return { state, sentPrompts, saveCalls, api };
}

for (const [name, response] of [
  ["Vietnamese first response requesting continue", "Dàn ý 3 chương. CHỜ LỆNH CONTINUE"],
  ["English first response requesting continue", "A three-chapter outline. Awaiting CONTINUE"],
  ["first response without a continue keyword", "Outline: opening, conflict, resolution"]
]) {
  test(`${name} is retained as context and never saved`, async () => {
    const { state, saveCalls } = await receiveFirstResponse(response);

    assert.equal(state.scriptOutline, response);
    assert.equal(state.sheetWorkflowState, "GENERATE_SCRIPT_SECTION");
    assert.equal(state.activeJobId, null);
    assert.equal(saveCalls.length, 0);
  });
}

test("a recovered legacy script-stage response is also treated as outline", async () => {
  const response = "Legacy in-flight outline";
  const { state, saveCalls } = await receiveFirstResponse(response, { activeJobStage: "script" });

  assert.equal(state.scriptOutline, response);
  assert.equal(state.sheetWorkflowState, "GENERATE_SCRIPT_SECTION");
  assert.equal(saveCalls.length, 0);
});

test("the configured first continue prompt is sent exactly once", async () => {
  const { state, sentPrompts, api } = await receiveFirstResponse("Outline only");

  await api.runWorkflowStep();
  await api.runWorkflowStep();

  assert.equal(sentPrompts.length, 1);
  assert.equal(sentPrompts[0].prompt.includes("TIẾP TỤC THEO CẤU HÌNH"), true);
  assert.equal(state.sheetWorkflowState, "WAITING_FOR_SCRIPT_SECTION");
  assert.equal(state.activeJobStage, "script_section");
});

test("DOM ordered-list count overrides a misleading Section 1 prompt reference", async () => {
  const { state, sentPrompts, api } = await receiveFirstResponse(
    "Outline items rendered by ChatGPT without textual list markers",
    { scriptExpectedSections: 1 },
    { outlineSectionCount: 10 }
  );

  assert.equal(state.scriptExpectedSections, 10);
  await api.runWorkflowStep();

  assert.equal(sentPrompts.length, 1);
  assert.match(sentPrompts[0].prompt, /AUTO_PILOT_SECTION 1\/10/);
});

test("pause then resume before first continue still sends it once", async () => {
  const { state, sentPrompts, api } = await receiveFirstResponse("Outline before pause");

  await api.handlePause();
  await api.handleStart();
  await api.runWorkflowStep();
  await api.runWorkflowStep();

  assert.equal(sentPrompts.length, 1);
  assert.equal(state.status, "running");
  assert.equal(state.activeJobStage, "script_section");
});

test("service-worker reload after first continue does not send a duplicate", async () => {
  const { state, sentPrompts, saveCalls, api } = await receiveFirstResponse("Outline before reload");
  await api.runWorkflowStep();
  assert.equal(sentPrompts.length, 1);

  const reloadedApi = loadBackground(state, sentPrompts, saveCalls);
  await reloadedApi.runWorkflowStep();

  assert.equal(sentPrompts.length, 1);
  assert.equal(state.activeJobStage, "script_section");
});

test("reload with a lost active-job checkpoint does not resend first continue", async () => {
  const { state, sentPrompts, saveCalls, api } = await receiveFirstResponse("Outline before lost checkpoint");
  await api.runWorkflowStep();
  assert.equal(sentPrompts.length, 1);
  assert.equal(state.scriptFirstContinueSent, true);

  Object.assign(state, {
    activeJobId: null,
    activeJobStage: null,
    activeJobStartedAt: null,
    sheetWorkflowState: "GENERATE_SCRIPT_SECTION"
  });

  const reloadedApi = loadBackground(state, sentPrompts, saveCalls);
  await reloadedApi.runWorkflowStep();

  assert.equal(sentPrompts.length, 1);
  assert.equal(state.status, "paused");
});

test("a new topic resets the first-continue checkpoint", async () => {
  const state = firstResponseState({
    sheetWorkflowState: "GENERATE_SCRIPT",
    currentTopic: "Topic B",
    promptND: "Write a script for {TOPIC}",
    activeJobId: null,
    activeJobStage: null,
    scriptOutline: "old outline",
    scriptSections: ["old section"],
    scriptSectionNumbers: [1]
  });
  const sentPrompts = [];
  const saveCalls = [];
  const api = loadBackground(state, sentPrompts, saveCalls);

  await api.runWorkflowStep();

  assert.equal(state.scriptOutline, "");
  assert.deepEqual(Array.from(state.scriptSections), []);
  assert.equal(sentPrompts.length, 1);

  await api.handleResponseComplete({
    jobId: state.activeJobId,
    response: "Fresh outline with no continue keyword"
  });
  await api.runWorkflowStep();

  assert.equal(sentPrompts.length, 2);
  assert.equal(sentPrompts[1].prompt.includes("TIẾP TỤC THEO CẤU HÌNH"), true);
  assert.equal(saveCalls.length, 0);
});
