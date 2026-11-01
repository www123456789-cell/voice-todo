/* 语音待办 - 自用插件，未发布 */
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => VoiceTodoPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// src/recorder.ts
var MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus"
];
function pickMimeType() {
  var _a;
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return (_a = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t))) != null ? _a : "";
}
function extForMime(mime) {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}
var VoiceRecorder = class {
  constructor() {
    this.mediaRecorder = null;
    this.chunks = [];
    this.stream = null;
    this.startedAt = 0;
    this.stopPromise = null;
  }
  get isRecording() {
    return this.mediaRecorder !== null && this.mediaRecorder.state === "recording";
  }
  get elapsedMs() {
    return this.isRecording ? Date.now() - this.startedAt : 0;
  }
  async start() {
    var _a;
    if (this.isRecording) throw new Error("\u5DF2\u7ECF\u5728\u5F55\u97F3\u4E86");
    if (!((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia)) {
      throw new Error("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301 getUserMedia");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1
      }
    });
    const mimeType = pickMimeType();
    try {
      this.mediaRecorder = mimeType ? new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 128e3 }) : new MediaRecorder(this.stream);
    } catch (err) {
      this.releaseStream();
      throw err;
    }
    this.chunks = [];
    this.mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    this.mediaRecorder.onerror = (ev) => {
      console.error("[voice-todo] MediaRecorder error", ev);
    };
    this.mediaRecorder.start(1e3);
    this.startedAt = Date.now();
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    const rec = this.mediaRecorder;
    if (!rec || rec.state === "inactive") {
      return Promise.reject(new Error("\u5F53\u524D\u6CA1\u6709\u5728\u5F55\u97F3"));
    }
    const durationMs = Date.now() - this.startedAt;
    this.stopPromise = new Promise((resolve, reject) => {
      rec.onstop = () => {
        try {
          const mimeType = rec.mimeType || "audio/webm";
          const blob = new Blob(this.chunks, { type: mimeType });
          this.chunks = [];
          this.mediaRecorder = null;
          this.stopPromise = null;
          this.releaseStream();
          if (blob.size === 0) {
            reject(new Error("\u5F55\u97F3\u4E3A\u7A7A\uFF08\u6CA1\u6709\u91C7\u5230\u58F0\u97F3\uFF09"));
            return;
          }
          resolve({ blob, mimeType, ext: extForMime(mimeType), durationMs });
        } catch (err) {
          this.stopPromise = null;
          reject(err);
        }
      };
      try {
        rec.stop();
      } catch (err) {
        this.stopPromise = null;
        reject(err);
      }
    });
    return this.stopPromise;
  }
  /** 丢弃当前录音（卸载插件、异常退出时用） */
  abort() {
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.onstop = null;
        this.mediaRecorder.stop();
      }
    } catch (err) {
      console.error("[voice-todo] abort failed", err);
    }
    this.mediaRecorder = null;
    this.chunks = [];
    this.stopPromise = null;
    this.releaseStream();
  }
  releaseStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
};

// src/transcribe.ts
var import_child_process = require("child_process");
var import_fs = require("fs");
var import_promises = require("fs/promises");
var import_os = require("os");
var import_path = require("path");
var LocalWhisperTranscriber = class {
  constructor(getSettings) {
    this.getSettings = getSettings;
  }
  async transcribe(audioAbsPath, timeoutMs = 15 * 60 * 1e3) {
    const s = this.getSettings();
    if (!(0, import_fs.existsSync)(s.pythonPath)) throw new Error(`\u627E\u4E0D\u5230 Python\uFF1A${s.pythonPath}`);
    if (!(0, import_fs.existsSync)(s.scriptPath)) throw new Error(`\u627E\u4E0D\u5230\u8F6C\u5199\u811A\u672C\uFF1A${s.scriptPath}`);
    if (!(0, import_fs.existsSync)(audioAbsPath)) throw new Error(`\u627E\u4E0D\u5230\u97F3\u9891\u6587\u4EF6\uFF1A${audioAbsPath}`);
    const outDir = await (0, import_promises.mkdtemp)((0, import_path.join)((0, import_os.tmpdir)(), "voice-todo-"));
    const args = [
      s.scriptPath,
      audioAbsPath,
      "--out",
      outDir,
      "--model",
      s.whisperModel || "small",
      "--lang",
      s.whisperLang || "auto"
    ];
    const env = { ...process.env };
    if (s.ffmpegDir) env.VIDEO_FFMPEG = s.ffmpegDir;
    if (s.asrHome) env.VIDEO_ASR_HOME = s.asrHome;
    try {
      await runProcess(s.pythonPath, args, env, timeoutMs);
      const produced = (await (0, import_promises.readdir)(outDir)).filter((f) => f.toLowerCase().endsWith(".txt"));
      if (produced.length === 0) throw new Error("\u8F6C\u5199\u8FDB\u7A0B\u7ED3\u675F\u4E86\uFF0C\u4F46\u6CA1\u6709\u4EA7\u51FA\u6587\u672C");
      const text = await (0, import_promises.readFile)((0, import_path.join)(outDir, produced[0]), "utf8");
      return text.trim();
    } finally {
      await (0, import_promises.rm)(outDir, { recursive: true, force: true }).catch(() => void 0);
    }
  }
};
function runProcess(command, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    var _a, _b;
    let stderr = "";
    let stdout = "";
    let settled = false;
    const child = (0, import_child_process.spawn)(command, args, { env, windowsHide: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch (e) {
      }
      reject(new Error(`\u8F6C\u5199\u8D85\u65F6\uFF08${Math.round(timeoutMs / 6e4)} \u5206\u949F\uFF09`));
    }, timeoutMs);
    (_a = child.stdout) == null ? void 0 : _a.on("data", (buf) => {
      stdout = (stdout + buf.toString("utf8")).slice(-4e3);
    });
    (_b = child.stderr) == null ? void 0 : _b.on("data", (buf) => {
      stderr = (stderr + buf.toString("utf8")).slice(-4e3);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`\u542F\u52A8\u8F6C\u5199\u8FDB\u7A0B\u5931\u8D25\uFF1A${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = (stderr || stdout).trim().split("\n").slice(-4).join(" / ");
      reject(new Error(`\u8F6C\u5199\u9000\u51FA\u7801 ${code}${detail ? `\uFF1A${detail}` : ""}`));
    });
  });
}

// src/transcribeCloud.ts
var import_obsidian = require("obsidian");
function buildMultipart(opts) {
  var _a;
  const boundary = (_a = opts.boundary) != null ? _a : `----voiceTodo${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const parts = [];
  const push = (text) => parts.push(encoder.encode(text));
  for (const [name, value] of Object.entries(opts.fields)) {
    push(`--${boundary}\r
Content-Disposition: form-data; name="${name}"\r
\r
${value}\r
`);
  }
  push(
    `--${boundary}\r
Content-Disposition: form-data; name="file"; filename="${opts.filename}"\r
Content-Type: ${opts.mime}\r
\r
`
  );
  parts.push(new Uint8Array(opts.file));
  push(`\r
--${boundary}--\r
`);
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return { body, boundary, contentType: `multipart/form-data; boundary=${boundary}` };
}
async function transcribeCloud(opts) {
  var _a, _b, _c, _d, _e;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fields = { model: opts.model, response_format: "json" };
  if (opts.language) fields.language = opts.language;
  const { body, contentType } = buildMultipart({
    fields,
    filename: opts.filename,
    mime: opts.mime,
    file: opts.audio
  });
  const resp = await (0, import_obsidian.requestUrl)({
    url: `${base}/audio/transcriptions`,
    method: "POST",
    contentType,
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body: body.buffer,
    throw: false
  });
  if (resp.status >= 400) {
    let detail = (_b = (_a = resp.text) == null ? void 0 : _a.slice(0, 300)) != null ? _b : "";
    try {
      const err = resp.json;
      detail = ((_c = err == null ? void 0 : err.error) == null ? void 0 : _c.message) || (err == null ? void 0 : err.message) || detail;
    } catch (e) {
    }
    throw new Error(`\u4E91\u7AEF\u8F6C\u5199 ${resp.status}\uFF1A${detail || "\u8BF7\u6C42\u5931\u8D25"}`);
  }
  const data = resp.json;
  if (typeof (data == null ? void 0 : data.text) === "string") return data.text.trim();
  const raw = (_e = (_d = resp.text) == null ? void 0 : _d.trim()) != null ? _e : "";
  if (raw && !raw.startsWith("{")) return raw;
  throw new Error("\u4E91\u7AEF\u8F6C\u5199\u8FD4\u56DE\u91CC\u6CA1\u6709 text \u5B57\u6BB5");
}

// src/polish.ts
var import_obsidian2 = require("obsidian");
var SYSTEM_PROMPT = [
  "\u4F60\u662F\u7B14\u8BB0\u6574\u7406\u52A9\u624B\u3002\u628A\u7528\u6237\u7ED9\u7684\u8BED\u97F3\u8F6C\u5199\u6574\u7406\u6210\u7ED3\u6784\u5316\u7B14\u8BB0\u3002",
  "\u786C\u6027\u8981\u6C42\uFF1A",
  "1. \u53EA\u6574\u7406\uFF0C\u4E0D\u65B0\u589E\u4E8B\u5B9E\uFF1B\u8F6C\u5199\u91CC\u6CA1\u6709\u7684\u4FE1\u606F\u4E00\u5F8B\u4E0D\u8981\u5199\u3002",
  "2. \u53BB\u6389\u53E3\u6C34\u8BCD\u548C\u91CD\u590D\uFF0C\u4FDD\u7559\u539F\u610F\uFF0C\u4E0D\u8981\u6269\u5199\u6210\u6563\u6587\u3002",
  "3. \u5F85\u529E\u53EA\u63D0\u53D6\u300C\u660E\u786E\u8981\u505A\u7684\u4E8B\u300D\uFF1B\u6CA1\u6709\u5C31\u8FD4\u56DE\u7A7A\u6570\u7EC4\uFF0C\u4E0D\u8981\u51D1\u6570\u3002",
  "4. \u53EA\u8F93\u51FA JSON\uFF0C\u4E0D\u8981 Markdown \u4EE3\u7801\u5757\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002",
  '\u8F93\u51FA\u7ED3\u6784\uFF1A{"title": "\u4E0D\u8D85\u8FC720\u5B57", "summary": "\u4E00\u53E5\u8BDD\u63D0\u8981", "body": "\u6574\u7406\u540E\u7684\u6B63\u6587\uFF0C\u5206\u70B9\u6216\u77ED\u6BB5\u843D\uFF0C400\u5B57\u4EE5\u5185", "todos": ["\u5F85\u529E1", "\u5F85\u529E2"]}'
].join("\n");
async function polishTranscript(opts) {
  var _a, _b, _c, _d, _e, _f, _g;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const resp = await (0, import_obsidian2.requestUrl)({
    url: `${base}/chat/completions`,
    method: "POST",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: opts.transcript }
      ],
      temperature: 0.3,
      max_tokens: 1200,
      response_format: { type: "json_object" }
    }),
    throw: false
  });
  if (resp.status >= 400) {
    let detail = (_b = (_a = resp.text) == null ? void 0 : _a.slice(0, 300)) != null ? _b : "";
    try {
      const err = resp.json;
      if ((_c = err == null ? void 0 : err.error) == null ? void 0 : _c.message) detail = err.error.message;
    } catch (e) {
    }
    throw new Error(`DeepSeek ${resp.status}\uFF1A${detail || "\u8BF7\u6C42\u5931\u8D25"}`);
  }
  const data = resp.json;
  const content = (_g = (_f = (_e = (_d = data == null ? void 0 : data.choices) == null ? void 0 : _d[0]) == null ? void 0 : _e.message) == null ? void 0 : _f.content) != null ? _g : "";
  const parsed = parseJson(content);
  if (!parsed) throw new Error("\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u5408\u6CD5 JSON");
  const todosRaw = Array.isArray(parsed.todos) ? parsed.todos : [];
  const todos = todosRaw.map((t) => typeof t === "string" ? t : "").map((t) => t.trim()).filter((t) => t.length > 0);
  return {
    title: typeof parsed.title === "string" ? parsed.title.trim() : "",
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
    body: typeof parsed.body === "string" ? parsed.body.trim() : "",
    todos
  };
}
function parseJson(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : null;
  } catch (e) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

// src/settings.ts
var HOME = "C:\\Users\\theon";
var DEFAULT_SETTINGS = {
  audioFolder: "\u9644\u4EF6/\u5F55\u97F3",
  noteFolder: "\u8BED\u97F3\u7B14\u8BB0",
  insertIntoActiveNote: true,
  autoTranscribe: true,
  pythonPath: `${HOME}\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe`,
  scriptPath: `${HOME}\\.dsh\\skills\\video-transcribe\\scripts\\video_transcribe.py`,
  ffmpegDir: `${HOME}\\.dsh\\tools\\ffmpeg\\bin`,
  asrHome: `${HOME}\\Documents\\ChatGPT\\\u89C6\u9891\\_asr`,
  whisperModel: "small",
  whisperLang: "auto",
  autoPolish: true,
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-chat",
  deepseekApiKey: "",
  todoFilePath: "Todo.md",
  todoScanFolder: "\u8BED\u97F3\u7B14\u8BB0",
  transcribeEngine: "local",
  cloudBaseUrl: "https://api.siliconflow.cn/v1",
  cloudModel: "FunAudioLLM/SenseVoiceSmall",
  cloudApiKey: "",
  stripEmoji: true,
  renameNoteByTitle: true
};
var DEEPSEEK_SECRET_ID = "voice-todo-deepseek";
var ASR_SECRET_ID = "voice-todo-asr";

// src/text.ts
function stripEmoji(input) {
  if (!input) return "";
  return input.replace(/<\|[^|]*\|>/g, "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}]/gu, "").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function sanitizeTitle(title) {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

// src/main.ts
var AUDIO_EXT = /\.(webm|m4a|mp3|wav|ogg|opus|mp4)$/i;
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1e3));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function trimSlashes(p) {
  return p.replace(/^\/+|\/+$/g, "").trim();
}
function newMarker() {
  return `vt-${Math.random().toString(36).slice(2, 8)}`;
}
function normalizeTaskText(raw) {
  return raw.replace(/\s*←\s*\[\[[^\]]*\]\]\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}
var VoiceTodoPlugin = class extends import_obsidian3.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
    this.recorder = new VoiceRecorder();
    this.transcriber = new LocalWhisperTranscriber(() => this.settings);
    this.statusEl = null;
    this.timerId = null;
    this.lastAudioPath = null;
    this.busy = false;
  }
  async onload() {
    await this.loadSettings();
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("voice-todo-status");
    this.statusEl.setText("\u{1F399} \u5C31\u7EEA");
    this.statusEl.setAttribute("aria-label", "\u8BED\u97F3\u5F85\u529E\uFF1A\u70B9\u51FB\u5F00\u59CB / \u505C\u6B62\u5F55\u97F3");
    this.registerDomEvent(this.statusEl, "click", () => {
      void this.toggleRecording();
    });
    this.addRibbonIcon("mic", "\u8BED\u97F3\u5F85\u529E\uFF1A\u5F00\u59CB / \u505C\u6B62\u5F55\u97F3", () => {
      void this.toggleRecording();
    });
    this.addCommand({
      id: "toggle-recording",
      name: "\u5F00\u59CB / \u505C\u6B62\u5F55\u97F3",
      callback: () => void this.toggleRecording()
    });
    this.addCommand({
      id: "stop-recording",
      name: "\u505C\u6B62\u5F55\u97F3\u5E76\u4FDD\u5B58",
      callback: () => void this.stopRecording()
    });
    this.addCommand({
      id: "transcribe-note-audio",
      name: "\u8F6C\u5199\u5F53\u524D\u7B14\u8BB0\u91CC\u7684\u97F3\u9891",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md" || !import_obsidian3.Platform.isDesktopApp) return false;
        if (!checking) void this.transcribeNoteAudio(file);
        return true;
      }
    });
    this.addCommand({
      id: "ai-polish-note",
      name: "AI \u6574\u7406\u5F53\u524D\u7B14\u8BB0\uFF08\u63D0\u8981 / \u6B63\u6587 / \u5F85\u529E\uFF09",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.polishNote(file);
        return true;
      }
    });
    this.addCommand({
      id: "transcribe-note-cloud",
      name: "\u7528\u4E91\u7AEF\u8F6C\u5199\u5F53\u524D\u7B14\u8BB0\u91CC\u7684\u97F3\u9891",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.transcribeNoteAudio(file, "cloud");
        return true;
      }
    });
    this.addCommand({
      id: "aggregate-todos",
      name: "\u6C47\u603B\u5F85\u529E\u5230 Todo \u7B14\u8BB0",
      callback: () => void this.aggregateTodos()
    });
    this.addCommand({
      id: "open-last-audio",
      name: "\u6253\u5F00\u6700\u8FD1\u4E00\u6BB5\u5F55\u97F3",
      checkCallback: (checking) => {
        if (!this.lastAudioPath) return false;
        if (!checking) {
          const file = this.app.vault.getAbstractFileByPath(this.lastAudioPath);
          if (file instanceof import_obsidian3.TFile) void this.app.workspace.getLeaf(true).openFile(file);
        }
        return true;
      }
    });
    this.addSettingTab(new VoiceTodoSettingTab(this.app, this));
    this.registerMarkdownPostProcessor((el, ctx) => this.addRetryButton(el, ctx.sourcePath));
  }
  onunload() {
    this.clearTimer();
    this.recorder.abort();
  }
  async toggleRecording() {
    if (this.recorder.isRecording) {
      await this.stopRecording();
      return;
    }
    await this.startRecording();
  }
  async startRecording() {
    var _a, _b;
    if (this.recorder.isRecording) return;
    try {
      await this.recorder.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new import_obsidian3.Notice(`\u65E0\u6CD5\u5F00\u59CB\u5F55\u97F3\uFF1A${msg}
\u8BF7\u68C0\u67E5\u7CFB\u7EDF\u9EA6\u514B\u98CE\u6743\u9650\u548C\u8F93\u5165\u8BBE\u5907\u3002`, 8e3);
      console.error("[voice-todo] start failed", err);
      return;
    }
    (_a = this.statusEl) == null ? void 0 : _a.addClass("is-recording");
    (_b = this.statusEl) == null ? void 0 : _b.setText("\u{1F399} 00:00");
    this.startTimer();
    new import_obsidian3.Notice("\u5F00\u59CB\u5F55\u97F3");
  }
  async stopRecording() {
    var _a, _b, _c, _d;
    if (!this.recorder.isRecording) return;
    this.clearTimer();
    (_a = this.statusEl) == null ? void 0 : _a.removeClass("is-recording");
    (_b = this.statusEl) == null ? void 0 : _b.setText("\u23F3 \u4FDD\u5B58\u4E2D");
    let result;
    try {
      result = await this.recorder.stop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      (_c = this.statusEl) == null ? void 0 : _c.setText("\u{1F399} \u5C31\u7EEA");
      new import_obsidian3.Notice(`\u5F55\u97F3\u5931\u8D25\uFF1A${msg}`, 8e3);
      console.error("[voice-todo] stop failed", err);
      return;
    }
    try {
      const saved = await this.saveAudio(result);
      this.lastAudioPath = saved.path;
      const marker = newMarker();
      const target = await this.attachAudio(saved.path, saved.name, result, marker);
      new import_obsidian3.Notice(`\u5DF2\u4FDD\u5B58\uFF1A${saved.path}`);
      if (this.settings.autoTranscribe && import_obsidian3.Platform.isDesktopApp && target) {
        void this.runTranscription(target, saved.path, marker);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new import_obsidian3.Notice(`\u4FDD\u5B58\u5931\u8D25\uFF1A${msg}`, 8e3);
      console.error("[voice-todo] save failed", err);
    } finally {
      (_d = this.statusEl) == null ? void 0 : _d.setText("\u{1F399} \u5C31\u7EEA");
    }
  }
  async saveAudio(result) {
    const baseFolder = trimSlashes(this.settings.audioFolder) || "\u9644\u4EF6/\u5F55\u97F3";
    const folder = import_obsidian3.Platform.isDesktopApp ? (0, import_obsidian3.normalizePath)(`${baseFolder}/${(0, import_obsidian3.moment)().format("YYYY")}`) : (0, import_obsidian3.normalizePath)(`${baseFolder}/_mobile`);
    await this.ensureFolder(folder);
    const stamp = (0, import_obsidian3.moment)().format("YYYYMMDD-HHmmss");
    let name = `${stamp}.${result.ext}`;
    let path = (0, import_obsidian3.normalizePath)(`${folder}/${name}`);
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      name = `${stamp}-${i}.${result.ext}`;
      path = (0, import_obsidian3.normalizePath)(`${folder}/${name}`);
      i += 1;
    }
    await this.app.vault.createBinary(path, await result.blob.arrayBuffer());
    return { path, name };
  }
  /** 把音频写进笔记，返回目标文件和占位标记 */
  async attachAudio(audioPath, name, result, marker) {
    const embed = import_obsidian3.Platform.isDesktopApp ? `![[${audioPath}]]` : "> \u624B\u673A\u5F55\u97F3\uFF0C\u8F6C\u5199\u6210\u529F\u540E\u97F3\u9891\u4F1A\u81EA\u52A8\u5220\u9664\u3002";
    const placeholder = `%%${marker}%%
> \u23F3 \u8F6C\u5199\u4E2D\u2026`;
    const view = this.app.workspace.getActiveViewOfType(import_obsidian3.MarkdownView);
    if ((view == null ? void 0 : view.file) && this.settings.insertIntoActiveNote) {
      view.editor.replaceSelection(`

${embed}

${placeholder}
`);
      return view.file;
    }
    const year = (0, import_obsidian3.moment)().format("YYYY");
    const baseFolder = trimSlashes(this.settings.noteFolder) || "\u8BED\u97F3\u7B14\u8BB0";
    const folder = (0, import_obsidian3.normalizePath)(`${baseFolder}/${year}`);
    await this.ensureFolder(folder);
    const stamp = (0, import_obsidian3.moment)().format("YYYY-MM-DD HHmmss");
    let notePath = (0, import_obsidian3.normalizePath)(`${folder}/${stamp} \u8BED\u97F3.md`);
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(notePath)) {
      notePath = (0, import_obsidian3.normalizePath)(`${folder}/${stamp} \u8BED\u97F3 ${i}.md`);
      i += 1;
    }
    const frontmatter = [
      "---",
      `created: ${(0, import_obsidian3.moment)().format()}`,
      "source: voice",
      `duration: ${formatDuration(result.durationMs)}`
    ];
    if (import_obsidian3.Platform.isDesktopApp) frontmatter.push(`audio: "${audioPath}"`);
    frontmatter.push("---");
    const content = [
      ...frontmatter,
      "",
      embed,
      "",
      "## \u8F6C\u5199",
      "",
      placeholder,
      ""
    ].join("\n");
    void name;
    const file = await this.app.vault.create(notePath, content);
    await this.app.workspace.getLeaf(true).openFile(file);
    return file;
  }
  async runTranscription(file, audioPath, marker) {
    var _a, _b;
    if (this.busy) {
      new import_obsidian3.Notice("\u4E0A\u4E00\u6761\u8FD8\u5728\u8F6C\u5199\uFF0C\u7A0D\u540E\u518D\u8BD5");
      return;
    }
    this.busy = true;
    (_a = this.statusEl) == null ? void 0 : _a.setText("\u{1F4DD} \u8F6C\u5199\u4E2D");
    try {
      const raw = await this.transcribeAudio(audioPath);
      const text = this.settings.stripEmoji ? stripEmoji(raw) : raw;
      await this.replacePlaceholder(file, marker, text || "\uFF08\u6CA1\u6709\u8BC6\u522B\u5230\u8BED\u97F3\uFF09");
      if (!import_obsidian3.Platform.isDesktopApp) await this.removeAudio(audioPath);
      new import_obsidian3.Notice("\u8F6C\u5199\u5B8C\u6210");
      if (this.settings.autoPolish && this.getApiKey()) {
        await this.runPolish(file, text);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.replacePlaceholder(file, marker, `> \u26A0\uFE0F \u8F6C\u5199\u5931\u8D25\uFF1A${msg}`, true);
      new import_obsidian3.Notice(`\u8F6C\u5199\u5931\u8D25\uFF1A${msg}`, 8e3);
      console.error("[voice-todo] transcribe failed", err);
    } finally {
      this.busy = false;
      (_b = this.statusEl) == null ? void 0 : _b.setText("\u{1F399} \u5C31\u7EEA");
    }
  }
  /** 手动转写当前笔记里第一个音频嵌入 */
  async transcribeNoteAudio(file, force = null) {
    var _a;
    const content = await this.app.vault.read(file);
    const match = content.match(/!\[\[([^\]|#]+?)\]\].*?/);
    const link = (_a = match == null ? void 0 : match[1]) == null ? void 0 : _a.trim();
    if (!link || !AUDIO_EXT.test(link)) {
      new import_obsidian3.Notice("\u8FD9\u6761\u7B14\u8BB0\u91CC\u6CA1\u627E\u5230\u97F3\u9891\u5D4C\u5165\uFF08![[xxx.webm]]\uFF09");
      return;
    }
    const dest = this.app.metadataCache.getFirstLinkpathDest(link, file.path);
    if (!dest) {
      new import_obsidian3.Notice(`\u627E\u4E0D\u5230\u97F3\u9891\u6587\u4EF6\uFF1A${link}`);
      return;
    }
    new import_obsidian3.Notice("\u5F00\u59CB\u8F6C\u5199\u2026");
    try {
      const raw = await this.transcribeAudio(dest.path, force);
      const text = this.settings.stripEmoji ? stripEmoji(raw) : raw;
      await this.writeTranscriptSection(file, text || "\uFF08\u6CA1\u6709\u8BC6\u522B\u5230\u8BED\u97F3\uFF09");
      new import_obsidian3.Notice("\u8F6C\u5199\u5B8C\u6210");
      if (this.settings.autoPolish && this.getApiKey()) {
        await this.runPolish(file, text);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new import_obsidian3.Notice(`\u8F6C\u5199\u5931\u8D25\uFF1A${msg}`, 8e3);
      console.error("[voice-todo] transcribe note failed", err);
    }
  }
  async replacePlaceholder(file, marker, text, isError = false) {
    const block = `%%${marker}%%
> \u23F3 \u8F6C\u5199\u4E2D\u2026`;
    const replacement = `${text}
`;
    let current = await this.app.vault.read(file);
    if (!current.includes(block)) {
      await new Promise((r) => window.setTimeout(r, 1500));
      current = await this.app.vault.read(file);
    }
    const next = current.includes(block) ? current.replace(block, replacement) : `${current.replace(/\s*$/, "")}

${replacement}`;
    await this.app.vault.modify(file, next);
  }
  async writeTranscriptSection(file, text) {
    const current = await this.app.vault.read(file);
    const section = /(\n## 转写\s*\n)([\s\S]*?)(?=\n## |\s*$)/;
    let next;
    if (section.test(current)) {
      next = current.replace(section, `$1
${text}
`);
    } else {
      next = `${current.replace(/\s*$/, "")}

## \u8F6C\u5199

${text}
`;
    }
    await this.app.vault.modify(file, next.replace(/\n{3,}/g, "\n\n"));
  }
  async writeAiError(file, msg) {
    const line = `<!-- vt:ai:error -->
> \u26A0\uFE0F \u6574\u7406\u5931\u8D25\uFF1A${msg}`;
    const current = await this.app.vault.read(file);
    const region = /<!-- vt:ai:error -->\n>[^\n]*/;
    let next;
    if (region.test(current)) {
      next = current.replace(region, line);
    } else {
      const idx = current.indexOf("## \u8F6C\u5199");
      next = idx >= 0 ? `${current.slice(0, idx)}${line}

${current.slice(idx)}` : `${current.replace(/\s*$/, "")}

${line}
`;
    }
    await this.app.vault.modify(file, next);
  }
  /** 把扫描目录里的未完成待办汇总到 Todo 笔记，按文本去重 */
  async aggregateTodos() {
    const folder = (0, import_obsidian3.normalizePath)(trimSlashes(this.settings.todoScanFolder) || "\u8BED\u97F3\u7B14\u8BB0");
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path === folder || f.path.startsWith(`${folder}/`));
    if (files.length === 0) {
      new import_obsidian3.Notice(`\u300C${folder}\u300D\u91CC\u6CA1\u6709\u7B14\u8BB0`);
      return;
    }
    const todoPath = (0, import_obsidian3.normalizePath)(trimSlashes(this.settings.todoFilePath) || "Todo.md");
    let target = this.app.vault.getAbstractFileByPath(todoPath);
    if (!(target instanceof import_obsidian3.TFile)) {
      const parent = todoPath.includes("/") ? todoPath.slice(0, todoPath.lastIndexOf("/")) : "";
      if (parent) await this.ensureFolder(parent);
      target = await this.app.vault.create(todoPath, "# \u5F85\u529E\n");
    }
    const todoFile = target;
    const existing = await this.app.vault.read(todoFile);
    const known = /* @__PURE__ */ new Set();
    for (const m of existing.matchAll(/^- \[[ xX]\] (.+)$/gm)) {
      known.add(normalizeTaskText(m[1]));
    }
    const added = [];
    for (const file of files) {
      if (file.path === todoFile.path) continue;
      const content = await this.app.vault.read(file);
      const aiRegion = content.match(/<!-- vt:ai:start -->([\s\S]*?)<!-- vt:ai:end -->/);
      const scope = aiRegion ? aiRegion[1] : content;
      for (const m of scope.matchAll(/^- \[ \] (.+)$/gm)) {
        const text = m[1].trim().replace(/\s*←\s*\[\[[^\]]*\]\]\s*$/, "");
        if (!text) continue;
        const key = normalizeTaskText(text);
        if (known.has(key)) continue;
        known.add(key);
        added.push({ text, source: file.basename });
      }
    }
    if (added.length === 0) {
      new import_obsidian3.Notice("\u6CA1\u6709\u65B0\u7684\u5F85\u529E");
      return;
    }
    const today = (0, import_obsidian3.moment)().format("YYYY-MM-DD");
    const heading = `## ${today}`;
    const newLines = added.map((a) => `- [ ] ${a.text} \u2190 [[${a.source}]]`);
    const lines = existing.split("\n");
    const idx = lines.findIndex((l) => l.trim() === heading);
    let out;
    if (idx >= 0) {
      let end = lines.length;
      for (let i = idx + 1; i < lines.length; i += 1) {
        if (lines[i].startsWith("## ")) {
          end = i;
          break;
        }
      }
      let insertAt = end;
      while (insertAt > idx + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
      out = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)];
    } else {
      out = [...lines, "", heading, "", ...newLines, ""];
    }
    await this.app.vault.modify(todoFile, out.join("\n"));
    new import_obsidian3.Notice(`\u65B0\u589E ${added.length} \u6761\u5F85\u529E \u2192 ${todoPath}`);
  }
  getSecretStore() {
    var _a;
    const app = this.app;
    return (_a = app.secretStorage) != null ? _a : null;
  }
  readSecret(id) {
    const store = this.getSecretStore();
    if (store) {
      try {
        const value = store.getSecret(id);
        if (value) return value.trim();
      } catch (err) {
        console.error("[voice-todo] read secret failed", err);
      }
    }
    return "";
  }
  writeSecret(id, value) {
    const store = this.getSecretStore();
    if (!store) return false;
    try {
      if (value) store.setSecret(id, value);
      return true;
    } catch (err) {
      console.error("[voice-todo] write secret failed", err);
      return false;
    }
  }
  getApiKey() {
    return this.readSecret(DEEPSEEK_SECRET_ID) || (this.settings.deepseekApiKey || "").trim();
  }
  saveApiKey(value) {
    return this.writeSecret(DEEPSEEK_SECRET_ID, value);
  }
  getAsrKey() {
    return this.readSecret(ASR_SECRET_ID) || (this.settings.cloudApiKey || "").trim();
  }
  saveAsrKey(value) {
    return this.writeSecret(ASR_SECRET_ID, value);
  }
  hasApiKey() {
    return this.getApiKey().length > 0;
  }
  async transcribeAudio(vaultPath, force = null) {
    const engine = force != null ? force : import_obsidian3.Platform.isDesktopApp ? this.settings.transcribeEngine : "cloud";
    if (engine === "cloud") return this.transcribeCloudFile(vaultPath);
    return this.transcriber.transcribe(this.absolute(vaultPath));
  }
  async transcribeCloudFile(vaultPath) {
    const key = this.getAsrKey();
    if (!key) throw new Error("\u8FD8\u6CA1\u914D\u7F6E\u4E91\u7AEF\u8F6C\u5199 API Key\uFF08\u8BBE\u7F6E \u2192 \u8BED\u97F3\u5F85\u529E \u2192 \u4E91\u7AEF\u8F6C\u5199\uFF09");
    const audio = await this.app.vault.adapter.readBinary(vaultPath);
    const filename = vaultPath.split("/").pop() || "audio.webm";
    const mime = filename.endsWith(".m4a") ? "audio/mp4" : filename.endsWith(".mp3") ? "audio/mpeg" : filename.endsWith(".wav") ? "audio/wav" : filename.endsWith(".ogg") ? "audio/ogg" : "audio/webm";
    return transcribeCloud({
      baseUrl: this.settings.cloudBaseUrl,
      apiKey: key,
      model: this.settings.cloudModel,
      audio,
      filename,
      mime,
      language: this.settings.whisperLang === "auto" ? void 0 : this.settings.whisperLang
    });
  }
  /** 在「整理失败 / 转写失败」提示后面挂一个重试按钮 */
  addRetryButton(el, sourcePath) {
    var _a;
    const candidates = Array.from(el.querySelectorAll("p, blockquote, .callout, .callout-content"));
    for (const node of candidates) {
      const text = (_a = node.textContent) != null ? _a : "";
      if (!text.includes("\u6574\u7406\u5931\u8D25") && !text.includes("\u8F6C\u5199\u5931\u8D25") && !text.includes("\u23F3 \u8F6C\u5199\u4E2D")) continue;
      if (node.querySelector("button.vt-retry")) return;
      const btn = document.createElement("button");
      btn.className = "vt-retry";
      btn.textContent = "\u91CD\u8BD5";
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        void this.retryNote(sourcePath);
      });
      node.appendChild(btn);
      return;
    }
  }
  async retryNote(path) {
    var _a, _b;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof import_obsidian3.TFile)) return;
    const content = await this.app.vault.read(file);
    if (content.includes("\u6574\u7406\u5931\u8D25") || content.includes("<!-- vt:ai:error -->")) {
      const match = content.match(/\n## 转写\s*\n([\s\S]*?)(?=\n## |\s*$)/);
      const transcript = (_b = (_a = match == null ? void 0 : match[1]) == null ? void 0 : _a.trim()) != null ? _b : "";
      if (transcript) {
        await this.runPolish(file, transcript);
        return;
      }
    }
    if (content.includes("\u8F6C\u5199\u5931\u8D25") || content.includes("\u23F3 \u8F6C\u5199\u4E2D")) {
      await this.transcribeNoteAudio(file);
    }
  }
  async polishNote(file) {
    var _a, _b;
    const content = await this.app.vault.read(file);
    const match = content.match(/\n## 转写\s*\n([\s\S]*?)(?=\n## |\s*$)/);
    const transcript = (_b = (_a = match == null ? void 0 : match[1]) == null ? void 0 : _a.trim()) != null ? _b : "";
    if (!transcript) {
      new import_obsidian3.Notice("\u8FD9\u6761\u7B14\u8BB0\u91CC\u6CA1\u6709\u300C## \u8F6C\u5199\u300D\u5185\u5BB9");
      return;
    }
    await this.runPolish(file, transcript);
  }
  async runPolish(file, transcript) {
    var _a, _b;
    const apiKey = this.getApiKey();
    if (!apiKey) {
      await this.writeAiError(file, "\u8FD8\u6CA1\u914D\u7F6E DeepSeek API Key\uFF08\u8BBE\u7F6E \u2192 \u8BED\u97F3\u5F85\u529E \u2192 AI \u6574\u7406\uFF09");
      new import_obsidian3.Notice("\u8FD8\u6CA1\u914D\u7F6E DeepSeek API Key\uFF08\u8BBE\u7F6E \u2192 \u8BED\u97F3\u5F85\u529E\uFF09");
      return;
    }
    if (!transcript.trim()) return;
    (_a = this.statusEl) == null ? void 0 : _a.setText("\u{1F916} \u6574\u7406\u4E2D");
    try {
      const result = await polishTranscript({
        apiKey,
        baseUrl: this.settings.deepseekBaseUrl,
        model: this.settings.deepseekModel,
        transcript
      });
      await this.applyAiBlock(file, result);
      new import_obsidian3.Notice("\u6574\u7406\u5B8C\u6210");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.writeAiError(file, msg);
      new import_obsidian3.Notice(`\u6574\u7406\u5931\u8D25\uFF1A${msg}`, 8e3);
      console.error("[voice-todo] polish failed", err);
    } finally {
      (_b = this.statusEl) == null ? void 0 : _b.setText("\u{1F399} \u5C31\u7EEA");
    }
  }
  async applyAiBlock(file, result) {
    const parts = [];
    if (result.summary) parts.push(`## \u63D0\u8981

${result.summary}`);
    if (result.body) parts.push(`## \u6B63\u6587

${result.body}`);
    if (result.todos.length > 0) {
      parts.push(`## \u5F85\u529E

${result.todos.map((t) => `- [ ] ${t}`).join("\n")}`);
    }
    if (parts.length === 0) return;
    const block = `<!-- vt:ai:start -->
${parts.join("\n\n")}
<!-- vt:ai:end -->`;
    const current = await this.app.vault.read(file);
    const region = /<!-- vt:ai:start -->[\s\S]*?<!-- vt:ai:end -->/;
    let next;
    if (region.test(current)) {
      next = current.replace(region, block);
    } else {
      const idx = current.indexOf("## \u8F6C\u5199");
      next = idx >= 0 ? `${current.slice(0, idx)}${block}

${current.slice(idx)}` : `${current.replace(/\s*$/, "")}

${block}
`;
    }
    await this.app.vault.modify(file, next.replace(/<!-- vt:ai:error -->\n>[^\n]*\n?/, ""));
    if (result.title) {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm.ai_title = result.title;
      });
      if (this.settings.renameNoteByTitle) await this.renameByTitle(file, result.title);
    }
  }
  async renameByTitle(file, title) {
    var _a;
    const clean = sanitizeTitle(title);
    if (!clean || /无法|未知|未识别/.test(clean)) return;
    const match = file.basename.match(/^(\d{4}-\d{2}-\d{2}) (\d{6})/);
    const prefix = match ? `${match[1]} ${match[2]}` : (0, import_obsidian3.moment)(file.stat.ctime).format("YYYY-MM-DD HHmmss");
    const parent = (_a = file.parent) == null ? void 0 : _a.path;
    const folder = parent && parent !== "/" ? `${parent}/` : "";
    const target = (0, import_obsidian3.normalizePath)(`${folder}${prefix} ${clean}.md`);
    if (target === file.path) return;
    if (this.app.vault.getAbstractFileByPath(target)) return;
    try {
      await this.app.fileManager.renameFile(file, target);
    } catch (err) {
      console.error("[voice-todo] rename failed", err);
    }
  }
  async removeAudio(vaultPath) {
    try {
      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      if (file) await this.app.vault.delete(file);
    } catch (err) {
      console.error("[voice-todo] delete audio failed", err);
    }
  }
  absolute(vaultPath) {
    const adapter = this.app.vault.adapter;
    if (typeof adapter.getFullPath === "function") return adapter.getFullPath(vaultPath);
    return vaultPath;
  }
  async ensureFolder(path) {
    const parts = (0, import_obsidian3.normalizePath)(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      try {
        await this.app.vault.createFolder(current);
      } catch (err) {
        if (!this.app.vault.getAbstractFileByPath(current)) throw err;
      }
    }
  }
  startTimer() {
    this.clearTimer();
    this.timerId = window.setInterval(() => {
      var _a;
      (_a = this.statusEl) == null ? void 0 : _a.setText(`\u{1F399} ${formatDuration(this.recorder.elapsedMs)}`);
    }, 500);
  }
  clearTimer() {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
  }
  async loadSettings() {
    const stored = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...stored != null ? stored : {} };
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
var VoiceTodoSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian3.Setting(containerEl).setName("\u4FDD\u5B58").setHeading();
    new import_obsidian3.Setting(containerEl).setName("\u5F55\u97F3\u4FDD\u5B58\u76EE\u5F55").setDesc("\u76F8\u5BF9\u4ED3\u5E93\u6839\u76EE\u5F55\uFF0C\u6309\u5E74\u4EFD\u81EA\u52A8\u5EFA\u5B50\u76EE\u5F55\u3002").addText(
      (text) => text.setPlaceholder(DEFAULT_SETTINGS.audioFolder).setValue(this.plugin.settings.audioFolder).onChange(async (value) => {
        this.plugin.settings.audioFolder = value || DEFAULT_SETTINGS.audioFolder;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u72EC\u7ACB\u7B14\u8BB0\u76EE\u5F55").setDesc("\u6CA1\u6709\u6253\u5F00\u7684\u7B14\u8BB0\u65F6\uFF0C\u5F55\u97F3\u4F1A\u65B0\u5EFA\u4E00\u6761\u7B14\u8BB0\u653E\u5728\u8FD9\u91CC\u3002").addText(
      (text) => text.setPlaceholder(DEFAULT_SETTINGS.noteFolder).setValue(this.plugin.settings.noteFolder).onChange(async (value) => {
        this.plugin.settings.noteFolder = value || DEFAULT_SETTINGS.noteFolder;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u5F55\u5230\u5F53\u524D\u7B14\u8BB0").setDesc("\u6253\u5F00\u7740\u7B14\u8BB0\u65F6\uFF0C\u628A\u97F3\u9891\u94FE\u63A5\u63D2\u5230\u5149\u6807\u5904\uFF1B\u5173\u95ED\u5219\u6C38\u8FDC\u65B0\u5EFA\u7B14\u8BB0\u3002").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.insertIntoActiveNote).onChange(async (value) => {
        this.plugin.settings.insertIntoActiveNote = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u8F6C\u5199\uFF08\u4EC5\u684C\u9762\u7AEF\uFF09").setHeading();
    new import_obsidian3.Setting(containerEl).setName("\u505C\u5F55\u540E\u81EA\u52A8\u8F6C\u5199").setDesc("\u7528\u672C\u673A faster-whisper\uFF0C\u4E0D\u8054\u7F51\u3001\u4E0D\u82B1\u94B1\u3002\u624B\u673A\u7AEF\u4E0D\u652F\u6301\u3002").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoTranscribe).onChange(async (value) => {
        this.plugin.settings.autoTranscribe = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("python.exe \u8DEF\u5F84").setDesc("DSH \u8FD0\u884C\u65F6\u81EA\u5E26\u7684 Python\uFF0C\u88C5\u4E86 faster-whisper\u3002").addText(
      (text) => text.setValue(this.plugin.settings.pythonPath).onChange(async (value) => {
        this.plugin.settings.pythonPath = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u8F6C\u5199\u811A\u672C\u8DEF\u5F84").setDesc("video-transcribe \u6280\u80FD\u91CC\u7684 video_transcribe.py\u3002").addText(
      (text) => text.setValue(this.plugin.settings.scriptPath).onChange(async (value) => {
        this.plugin.settings.scriptPath = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("ffmpeg \u76EE\u5F55").setDesc("\u5185\u542B ffmpeg.exe \u7684\u76EE\u5F55\uFF0C\u811A\u672C\u9760\u5B83\u62BD\u97F3\u8F68\u3002").addText(
      (text) => text.setValue(this.plugin.settings.ffmpegDir).onChange(async (value) => {
        this.plugin.settings.ffmpegDir = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u8F6C\u5199\u6A21\u578B").setDesc("small \u591F\u7528\uFF1Bmedium \u66F4\u51C6\u4F46\u6162\u3002").addDropdown(
      (dd) => dd.addOptions({
        tiny: "tiny",
        base: "base",
        small: "small",
        medium: "medium",
        "large-v3": "large-v3"
      }).setValue(this.plugin.settings.whisperModel).onChange(async (value) => {
        this.plugin.settings.whisperModel = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u97F3\u9891\u8BED\u8A00").setDesc("\u4FDD\u6301 auto\uFF0C\u5F3A\u5236 zh \u4F1A\u8BA9\u82F1\u6587\u97F3\u9891\u51FA\u4E71\u7801\u3002").addDropdown(
      (dd) => dd.addOptions({ auto: "auto", zh: "\u4E2D\u6587", en: "\u82F1\u6587", ja: "\u65E5\u6587" }).setValue(this.plugin.settings.whisperLang).onChange(async (value) => {
        this.plugin.settings.whisperLang = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u6E05\u7406\u8F6C\u5199\u91CC\u7684\u8868\u60C5\u7B26\u53F7").setDesc("\u4E91\u7AEF\u53E3\u8BED\u6A21\u578B\u4F1A\u5F80\u6587\u672C\u91CC\u585E\u8868\u60C5\u548C\u60C5\u611F\u6807\u8BB0\uFF0C\u9ED8\u8BA4\u5220\u6389\uFF0C\u4E0D\u6539\u6587\u5B57\u3002").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.stripEmoji).onChange(async (value) => {
        this.plugin.settings.stripEmoji = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u4E91\u7AEF\u8F6C\u5199\uFF08\u624B\u673A\u7AEF\u5FC5\u7528\uFF09").setHeading();
    new import_obsidian3.Setting(containerEl).setName("\u8F6C\u5199\u5F15\u64CE").setDesc("\u672C\u5730\u66F4\u5FEB\u66F4\u7701\u94B1\uFF1B\u624B\u673A\u7AEF\u6CA1\u6709\u672C\u5730\u8F6C\u5199\uFF0C\u4F1A\u5F3A\u5236\u8D70\u4E91\u7AEF\u3002").addDropdown(
      (dd) => dd.addOptions({ local: "\u672C\u5730 faster-whisper", cloud: "\u4E91\u7AEF OpenAI \u517C\u5BB9\u63A5\u53E3" }).setValue(this.plugin.settings.transcribeEngine).onChange(async (value) => {
        this.plugin.settings.transcribeEngine = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u4E91\u7AEF\u63A5\u53E3\u5730\u5740").setDesc("\u793A\u4F8B\uFF1A\u7845\u57FA\u6D41\u52A8 https://api.siliconflow.cn/v1").addText(
      (text) => text.setValue(this.plugin.settings.cloudBaseUrl).onChange(async (value) => {
        this.plugin.settings.cloudBaseUrl = value.trim() || DEFAULT_SETTINGS.cloudBaseUrl;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u4E91\u7AEF\u6A21\u578B\u540D").setDesc("\u7845\u57FA\u6D41\u52A8\u53EF\u586B FunAudioLLM/SenseVoiceSmall\uFF1B\u5176\u4ED6\u670D\u52A1\u6309\u6587\u6863\u586B\u3002").addText(
      (text) => text.setValue(this.plugin.settings.cloudModel).onChange(async (value) => {
        this.plugin.settings.cloudModel = value.trim() || DEFAULT_SETTINGS.cloudModel;
        await this.plugin.saveSettings();
      })
    );
    let pendingAsrKey = "";
    const asrKeySetting = new import_obsidian3.Setting(containerEl).setName("\u4E91\u7AEF\u8F6C\u5199 API Key").setDesc(
      this.plugin.getAsrKey() ? "\u5DF2\u914D\u7F6E\uFF08\u5B58\u4E8E SecretStorage\uFF09" : "\u548C DeepSeek \u7684 key \u4E0D\u662F\u540C\u4E00\u4E2A\uFF0C\u9700\u8981\u5355\u72EC\u586B\u3002"
    );
    asrKeySetting.addText((text) => {
      text.setPlaceholder("sk-...").onChange((v) => {
        pendingAsrKey = v.trim();
      });
      text.inputEl.type = "password";
    });
    asrKeySetting.addButton(
      (btn) => btn.setButtonText("\u4FDD\u5B58").onClick(async () => {
        if (!pendingAsrKey) {
          new import_obsidian3.Notice("\u5148\u586B key");
          return;
        }
        if (this.plugin.saveAsrKey(pendingAsrKey)) {
          pendingAsrKey = "";
          new import_obsidian3.Notice("\u5DF2\u4FDD\u5B58\u5230 SecretStorage");
          this.display();
          return;
        }
        this.plugin.settings.cloudApiKey = pendingAsrKey;
        await this.plugin.saveSettings();
        pendingAsrKey = "";
        new import_obsidian3.Notice("\u6CA1\u6709 SecretStorage\uFF0Ckey \u5DF2\u5199\u8FDB data.json");
        this.display();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("AI \u6574\u7406\uFF08DeepSeek\uFF09").setHeading();
    let pendingKey = "";
    const keySetting = new import_obsidian3.Setting(containerEl).setName("API Key").setDesc(
      this.plugin.hasApiKey() ? "\u5DF2\u914D\u7F6E\uFF08\u5B58\u4E8E SecretStorage\uFF0C\u4E0D\u5199\u8FDB data.json\uFF09" : "\u586B sk- \u5F00\u5934\u7684 key\uFF0C\u70B9\u300C\u4FDD\u5B58\u300D\u3002\u4FDD\u5B58\u540E\u8FD9\u91CC\u4E0D\u4F1A\u56DE\u663E\u3002"
    );
    keySetting.addText((text) => {
      text.setPlaceholder("sk-...").onChange((v) => {
        pendingKey = v.trim();
      });
      text.inputEl.type = "password";
    });
    keySetting.addButton(
      (btn) => btn.setButtonText("\u4FDD\u5B58").onClick(async () => {
        if (!pendingKey) {
          new import_obsidian3.Notice("\u5148\u586B key");
          return;
        }
        if (this.plugin.saveApiKey(pendingKey)) {
          pendingKey = "";
          new import_obsidian3.Notice("\u5DF2\u4FDD\u5B58\u5230 SecretStorage");
          this.display();
          return;
        }
        this.plugin.settings.deepseekApiKey = pendingKey;
        await this.plugin.saveSettings();
        pendingKey = "";
        new import_obsidian3.Notice("\u6CA1\u6709 SecretStorage\uFF0Ckey \u5DF2\u5199\u8FDB data.json\uFF0C\u6CE8\u610F\u522B\u540C\u6B65\u51FA\u53BB");
        this.display();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u8F6C\u5199\u540E\u81EA\u52A8\u6574\u7406").setDesc("\u8F6C\u5199\u5B8C\u6210\u81EA\u52A8\u8DD1\u4E00\u904D\uFF1A\u63D0\u8981\u3001\u6B63\u6587\u3001\u5F85\u529E\u3002\u4F1A\u4EA7\u751F\u5C11\u91CF API \u8D39\u7528\u3002").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoPolish).onChange(async (value) => {
        this.plugin.settings.autoPolish = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u6574\u7406\u540E\u6309\u6807\u9898\u91CD\u547D\u540D").setDesc("\u628A\u300C2026-10-31 234954 \u8BED\u97F3\u300D\u6539\u6210\u300C2026-10-31 234954 \u5F55\u97F3\u7ED3\u675F\u300D\u3002\u94FE\u63A5\u4F1A\u81EA\u52A8\u66F4\u65B0\u3002").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.renameNoteByTitle).onChange(async (value) => {
        this.plugin.settings.renameNoteByTitle = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u6A21\u578B").setDesc("deepseek-chat \u4FBF\u5B9C\u591F\u7528\uFF1Breasoner \u66F4\u6162\u4E5F\u66F4\u8D35\u3002").addDropdown(
      (dd) => dd.addOptions({ "deepseek-chat": "deepseek-chat", "deepseek-reasoner": "deepseek-reasoner" }).setValue(this.plugin.settings.deepseekModel).onChange(async (value) => {
        this.plugin.settings.deepseekModel = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u63A5\u53E3\u5730\u5740").setDesc("\u9ED8\u8BA4\u5B98\u65B9\u5730\u5740\uFF1B\u6362\u4E2D\u8F6C\u65F6\u6539\u8FD9\u91CC\u3002").addText(
      (text) => text.setValue(this.plugin.settings.deepseekBaseUrl).onChange(async (value) => {
        this.plugin.settings.deepseekBaseUrl = value.trim() || DEFAULT_SETTINGS.deepseekBaseUrl;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u5F85\u529E\u6C47\u603B").setHeading();
    new import_obsidian3.Setting(containerEl).setName("Todo \u7B14\u8BB0\u8DEF\u5F84").setDesc("\u6C47\u603B\u76EE\u6807\uFF0C\u4E0D\u5B58\u5728\u4F1A\u81EA\u52A8\u521B\u5EFA\uFF1B\u6309\u5F85\u529E\u6587\u672C\u53BB\u91CD\uFF0C\u5DF2\u52FE\u9009\u7684\u4E0D\u91CD\u590D\u6DFB\u52A0\u3002").addText(
      (text) => text.setValue(this.plugin.settings.todoFilePath).onChange(async (value) => {
        this.plugin.settings.todoFilePath = value.trim() || DEFAULT_SETTINGS.todoFilePath;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("\u626B\u63CF\u76EE\u5F55").setDesc("\u53EA\u4ECE\u8FD9\u4E2A\u76EE\u5F55\uFF08\u542B\u5B50\u76EE\u5F55\uFF09\u91CC\u627E\u672A\u5B8C\u6210\u7684 `- [ ]` \u5F85\u529E\u3002").addText(
      (text) => text.setValue(this.plugin.settings.todoScanFolder).onChange(async (value) => {
        this.plugin.settings.todoScanFolder = value.trim() || DEFAULT_SETTINGS.todoScanFolder;
        await this.plugin.saveSettings();
      })
    );
  }
};
