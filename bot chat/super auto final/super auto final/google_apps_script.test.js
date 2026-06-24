// google_apps_script.test.js
//
// Focused tests for the Google Apps Script prompt parser.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadAppsScript() {
  const source = fs.readFileSync(path.join(__dirname, "google_apps_script.js"), "utf8");
  const context = {
    console,
    Utilities: {
      getUuid() {
        return "test-uuid";
      },
      formatDate(date, tz, format) {
        return "2026-06-18 12:00:00";
      }
    },
    Session: {
      getScriptTimeZone() {
        return "GMT";
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "google_apps_script.js" });
  return context;
}

function setScriptToken(gas, token) {
  gas.PropertiesService = {
    getScriptProperties() {
      return {
        getProperty(name) {
          assert.equal(name, "SUPER_AUTO_API_TOKEN");
          return token;
        }
      };
    }
  };
}

function createFakeSheet(name, initialRows) {
  const data = (initialRows || []).map((row) => row.slice());

  function ensureCell(row, col) {
    while (data.length < row) data.push([]);
    while (data[row - 1].length < col) data[row - 1].push("");
  }

  function createRange(startRow, startCol, rowCount = 1, colCount = 1) {
    return {
      getValue() {
        ensureCell(startRow, startCol);
        return data[startRow - 1][startCol - 1] || "";
      },
      setValue(value) {
        ensureCell(startRow, startCol);
        data[startRow - 1][startCol - 1] = value;
        return this;
      },
      getValues() {
        const values = [];
        for (let r = 0; r < rowCount; r++) {
          const row = [];
          for (let c = 0; c < colCount; c++) {
            ensureCell(startRow + r, startCol + c);
            row.push(data[startRow + r - 1][startCol + c - 1] || "");
          }
          values.push(row);
        }
        return values;
      },
      setValues(values) {
        for (let r = 0; r < values.length; r++) {
          for (let c = 0; c < values[r].length; c++) {
            ensureCell(startRow + r, startCol + c);
            data[startRow + r - 1][startCol + c - 1] = values[r][c];
          }
        }
        return this;
      },
      setFontWeight() { return this; },
      setBackground() { return this; }
    };
  }

  return {
    _data: data,
    getName() {
      return name;
    },
    getLastRow() {
      let last = 0;
      data.forEach((row, index) => {
        if (row.some((cell) => String(cell || "").trim())) last = index + 1;
      });
      return last;
    },
    getLastColumn() {
      return data.reduce((max, row) => Math.max(max, row.length), 1);
    },
    getRange(row, col, rowCount, colCount) {
      return createRange(row, col, rowCount, colCount);
    },
    setFrozenRows() {
      return this;
    }
  };
}

function createFakeSpreadsheet(sheets) {
  const sheetList = sheets || [];
  return {
    getSheets() {
      return sheetList;
    },
    insertSheet(name) {
      const sheet = createFakeSheet(name, []);
      sheetList.push(sheet);
      return sheet;
    }
  };
}

function longPrompt(section, promptNo) {
  return [
    `Detailed historical painting, High Middle Ages England, winter of 1273, section ${section}, prompt ${promptNo}.`,
    "A complete standalone image prompt with medieval clothing, stone cottage details, warm firelight, snow outside, natural faces, practical objects, cinematic composition, historically grounded textures."
  ].join(" ");
}

function numberedSectionResponse(section, count = 5) {
  const lines = [];
  for (let i = 1; i <= count; i++) {
    lines.push(`${section}.${i} ${longPrompt(section, i)}`);
  }
  return lines.join("\n");
}

function standalonePrompt(section, name) {
  return [
    `Detailed historical painting, High Middle Ages England, winter of 1273, section ${section}, ${name} scene.`,
    "A complete standalone image prompt with medieval clothing, stone cottage details, warm firelight, snow outside, natural faces, practical objects, cinematic composition, historically grounded textures."
  ].join(" ");
}

test("parseImagePromptGroups parses 20 sections with 1.1 through 20.5 labels", () => {
  const gas = loadAppsScript();
  const entries = Array.from({ length: 20 }, (_, index) => {
    const section = index + 1;
    return {
      section,
      response: numberedSectionResponse(section)
    };
  });

  const groups = gas.parseImagePromptGroups(entries, { storySectionCount: 20 });

  assert.equal(groups.length, 20);
  assert.equal(groups[0].section, 1);
  assert.equal(groups[0].prompts.length, 5);
  assert.equal(groups[19].section, 20);
  assert.equal(groups[19].prompts.length, 5);
});

test("parseImagePromptGroups merges short English titles with their long prompt text", () => {
  const gas = loadAppsScript();
  const response = [
    `1.1 - Entering the Cottage\n${longPrompt(1, 1)}`,
    `1.2 - Life Around the Hearth\n${longPrompt(1, 2)}`,
    `1.3 - The Pottage Meal\n${longPrompt(1, 3)}`,
    `1.4 - Carrying Firewood Through the Blizzard\n${longPrompt(1, 4)}`,
    `1.5 - The Cottage Against the Storm\n${longPrompt(1, 5)}`
  ].join("\n");

  const groups = gas.parseImagePromptGroups([{ section: 1, response }], { storySectionCount: 1 });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].prompts.length, 5);
  assert.match(groups[0].prompts[0], /Entering the Cottage/);
  assert.match(groups[0].prompts[0], /Detailed historical painting/);
});

test("parseImagePromptGroups skips generated heading lines ending with prompts colon", () => {
  const gas = loadAppsScript();
  const response = [
    "High Middle Ages falcon tower interior (midday continuation) oil painting prompts:",
    standalonePrompt(1, "first"),
    standalonePrompt(1, "second"),
    standalonePrompt(1, "third"),
    standalonePrompt(1, "fourth"),
    standalonePrompt(1, "fifth")
  ].join("\n\n");

  const groups = gas.parseImagePromptGroups([{ section: 1, response }], { storySectionCount: 1 });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].prompts.length, 5);
  assert.doesNotMatch(groups[0].prompts[0], /prompts:/i);
  assert.match(groups[0].prompts[0], /first scene/);
  assert.match(groups[0].prompts[4], /fifth scene/);
});

test("parseImagePromptGroups does not count title-only lines as valid prompts", () => {
  const gas = loadAppsScript();
  const response = [
    "1.1 - Entering the Cottage",
    "1.2 - Life Around the Hearth",
    "1.3 - The Pottage Meal",
    "1.4 - Carrying Firewood Through the Blizzard",
    "1.5 - The Cottage Against the Storm"
  ].join("\n");

  const groups = gas.parseImagePromptGroups([{ section: 1, response }], { storySectionCount: 1 });

  assert.equal(groups.length, 0);
});

test("saveImagePromptsData rejects incomplete prompt sets by default", () => {
  const gas = loadAppsScript();
  gas.ensureBaseLayout = function () {};
  gas.resolveTopicRow = function () {
    return { row: 2, channel: "kenh 1", topic: "English topic", sheet: {} };
  };
  gas.validateJobOwner = function () {
    return "";
  };
  gas.getChannelSheet = function () {
    return {};
  };
  gas.ensureTopicBlock = function () {
    return 1;
  };
  gas.getAutoPilotConfig = function () {
    return {};
  };
  gas.readStoryParagraphsFromChannelSheet = function () {
    return Array.from({ length: 1 }, () => "story section");
  };

  const result = gas.saveImagePromptsData({}, {
    channel: "kenh 1",
    topic: "English topic",
    expectedSections: 1,
    imagePrompts: [{ section: 1, response: numberedSectionResponse(1, 3) }]
  });

  assert.match(result.error, /3\/5 prompt/);
});

test("detectExpectedStoryChapterCount avoids section-reference false positives", () => {
  const gas = loadAppsScript();

  assert.equal(gas.detectExpectedStoryChapterCount("Write exactly 20 sections. After Section 7, ask for CONTINUE."), 20);
  assert.equal(gas.detectExpectedStoryChapterCount("Chia thanh 12 chuong, moi chuong co mo dau rieng."), 12);
  assert.equal(gas.detectExpectedStoryChapterCount("Start with Section 1/18 and continue in order."), 18);
  assert.equal(gas.detectExpectedStoryChapterCount("Deliver in 20 numbered sections, 1100-1200 words EACH."), 20);
  assert.equal(gas.detectExpectedStoryChapterCount("Create 20 numbered chapters."), 20);
  assert.equal(gas.detectExpectedStoryChapterCount("After Section 20, remind me to continue."), 0);
  assert.equal(gas.detectExpectedStoryChapterCount("Use EXACTLY 5 bullets per section."), 0);
});

test("escapeSheetText: escapes only formula characters at the start of a trimmed string", () => {
  const gas = loadAppsScript();

  assert.equal(gas.escapeSheetText("=IMPORTXML(...)"), "'=IMPORTXML(...)");
  assert.equal(gas.escapeSheetText("  +123"), "'  +123");
  assert.equal(gas.escapeSheetText("-abc"), "'-abc");
  assert.equal(gas.escapeSheetText("@username"), "'@username");
  assert.equal(gas.escapeSheetText("Normal text"), "Normal text");
  assert.equal(gas.escapeSheetText("Chương 1"), "Chương 1");
  assert.equal(gas.escapeSheetText(123), 123);
  assert.equal(gas.escapeSheetText(null), null);
});

test("validateApiToken: allows URL-only mode unless a script token is configured", () => {
  const gas = loadAppsScript();

  setScriptToken(gas, "");
  assert.equal(gas.validateApiToken({ token: "anything" }), true);
  assert.equal(gas.validateApiToken({}), true);
  assert.equal(gas.validateApiToken(""), true);

  setScriptToken(gas, "expected-token");
  assert.equal(gas.validateApiToken({ token: "expected-token" }), true);
  assert.equal(gas.validateApiToken("expected-token"), true);
  assert.equal(gas.validateApiToken({ token: "wrong-token" }), false);
  assert.equal(gas.validateApiToken({}), false);
  assert.equal(gas.validateApiToken(""), false);
});

test("getPromptPair reads customizable continue prompts from prompt sheet", () => {
  const gas = loadAppsScript();
  const promptSheet = createFakeSheet("prompt", [
    ["prompt truyện", "prompt ảnh", "prompt sau 3 continue", "prompt continue", "prompt kết continue"],
    ["Story prompt", "Image prompt", "Diversity prompt", "CUSTOM CONTINUE", "CUSTOM FINAL CONTINUE"]
  ]);
  const ss = createFakeSpreadsheet([promptSheet]);

  const prompts = gas.getPromptPair(ss);

  assert.equal(prompts.promptND, "Story prompt");
  assert.equal(prompts.promptAnh, "Image prompt");
  assert.equal(prompts.scriptDiversityPrompt, "Diversity prompt");
  assert.equal(prompts.scriptContinuePrompt, "CUSTOM CONTINUE");
  assert.equal(prompts.scriptFinalContinuePrompt, "CUSTOM FINAL CONTINUE");
});

test("getAutoPilotConfig uses prompt sheet continue prompts unless Config overrides them", () => {
  const gas = loadAppsScript();
  const promptSheet = createFakeSheet("prompt", [
    ["prompt truyện", "prompt ảnh", "prompt sau 3 continue", "prompt continue", "prompt kết continue"],
    ["Write exactly 20 sections.", "", "", "SHEET CONTINUE", "SHEET FINAL"]
  ]);
  const configSheet = createFakeSheet("Auto Pilot Config", [
    ["scriptContinuePrompt", "CONFIG CONTINUE"],
    ["scriptFinalContinuePrompt", "CONFIG FINAL"]
  ]);

  const sheetOnlyConfig = gas.getAutoPilotConfig(createFakeSpreadsheet([promptSheet]));
  assert.equal(sheetOnlyConfig.scriptContinuePrompt, "SHEET CONTINUE");
  assert.equal(sheetOnlyConfig.scriptFinalContinuePrompt, "SHEET FINAL");

  const overriddenConfig = gas.getAutoPilotConfig(createFakeSpreadsheet([promptSheet, configSheet]));
  assert.equal(overriddenConfig.scriptContinuePrompt, "CONFIG CONTINUE");
  assert.equal(overriddenConfig.scriptFinalContinuePrompt, "CONFIG FINAL");
});

test("ensurePromptSheet adds continue headers to old three-column prompt sheets", () => {
  const gas = loadAppsScript();
  const promptSheet = createFakeSheet("prompt", [
    ["prompt truyện", "prompt ảnh", "prompt sau 3 continue"],
    ["Story prompt", "Image prompt", "Diversity prompt"]
  ]);
  const ss = createFakeSpreadsheet([promptSheet]);

  gas.ensurePromptSheet(ss);

  assert.deepEqual(promptSheet._data[0].slice(0, 5), [
    "prompt truyện",
    "prompt ảnh",
    "prompt sau 3 continue",
    "prompt continue",
    "prompt kết continue"
  ]);
  assert.deepEqual(promptSheet._data[1].slice(0, 3), [
    "Story prompt",
    "Image prompt",
    "Diversity prompt"
  ]);
});

test("saveScriptData overrides config.txtExportFolderId and resourceKey when folder URL is provided", () => {
  const gas = loadAppsScript();
  
  // Mock dependencies of saveScriptData
  gas.ensureBaseLayout = function () {};
  gas.resolveTopicRow = function () {
    return { row: 2, channel: "kenh 1", topic: "Test topic", sheet: {} };
  };
  gas.validateJobOwner = function () {
    return "";
  };
  gas.getAutoPilotConfig = function () {
    return {
      txtExportFolderId: "original-id",
      txtExportFolderResourceKey: "original-key"
    };
  };
  gas.getPromptPair = function () {
    return { promptND: "Chia thanh 5 chuong." };
  };
  gas.getChannelSheet = function () {
    return {
      getName() { return "kenh 1"; }
    };
  };
  gas.ensureTopicBlock = function () {
    return 1;
  };
  gas.writeStoryBlock = function () {};
  gas.setTopicState = function () {};
  gas.refreshOverview = function () {};

  // Capture the config passed to export folder function
  let capturedConfig = null;
  gas.exportCleanScriptTxt = function (channel, topic, paragraphs, config) {
    capturedConfig = config;
    return { id: "file-id", name: "test.txt", url: "http://file-url" };
  };

  // 1. Test when no override is passed
  gas.saveScriptData({}, {
    channel: "kenh 1",
    topic: "Test topic",
    script: "Noi dung 1. Noi dung 2. Noi dung 3."
  });
  assert.equal(capturedConfig.txtExportFolderId, "original-id");
  assert.equal(capturedConfig.txtExportFolderResourceKey, "original-key");

  // 2. Test when override folder URL is passed
  gas.saveScriptData({}, {
    channel: "kenh 1",
    topic: "Test topic",
    script: "Noi dung 1. Noi dung 2. Noi dung 3.",
    txtExportFolderUrl: "https://drive.google.com/drive/folders/overridden-folder-id?resourcekey=overridden-resource-key"
  });
  assert.equal(capturedConfig.txtExportFolderId, "overridden-folder-id");
  assert.equal(capturedConfig.txtExportFolderResourceKey, "overridden-resource-key");
});

