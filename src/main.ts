import {
	App,
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	moment,
	normalizePath,
	requestUrl,
} from "obsidian";
import { RecordingResult, VoiceRecorder } from "./recorder";
import { LocalWhisperTranscriber } from "./transcribe";
import { transcribeCloud } from "./transcribeCloud";
import { polishTranscript, PolishResult } from "./polish";
import { ASR_SECRET_ID, DEFAULT_SETTINGS, DEEPSEEK_SECRET_ID, VoiceTodoSettings } from "./settings";
import { sanitizeTitle, stripEmoji } from "./text";

const AUDIO_EXT = /\.(webm|m4a|mp3|wav|ogg|opus|mp4)$/i;

function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function trimSlashes(p: string): string {
	return p.replace(/^\/+|\/+$/g, "").trim();
}

function newMarker(): string {
	return `vt-${Math.random().toString(36).slice(2, 8)}`;
}

/** 待办去重用的规范化：去掉来源链接、压缩空白、统一大小写 */
function normalizeTaskText(raw: string): string {
	return raw
		.replace(/\s*←\s*\[\[[^\]]*\]\]\s*$/, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** 生成一段静音 wav，给「测试云端连通」用：只验证接口与 key，不传用户音频 */
function buildSilentWav(seconds = 0.4, sampleRate = 16000): ArrayBuffer {
	const samples = Math.floor(seconds * sampleRate);
	const dataSize = samples * 2;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const writeStr = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	writeStr(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeStr(36, "data");
	view.setUint32(40, dataSize, true);
	return buffer;
}

export default class VoiceTodoPlugin extends Plugin {
	settings: VoiceTodoSettings = { ...DEFAULT_SETTINGS };

	private readonly recorder = new VoiceRecorder();
	private readonly transcriber = new LocalWhisperTranscriber(() => this.settings);
	private statusEl: HTMLElement | null = null;
	private timerId: number | null = null;
	private lastAudioPath: string | null = null;
	private busy = false;
	/** 内存里的最近错误，诊断报告会带上（不落盘、不上传） */
	private readonly diagLog: string[] = [];

	private diag(message: string): void {
		this.diagLog.push(`${moment().format("MM-DD HH:mm:ss")} ${message}`);
		if (this.diagLog.length > 60) this.diagLog.shift();
		console.log(`[voice-todo] ${message}`);
	}

	async onload(): Promise<void> {
		await this.loadSettings();

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("voice-todo-status");
		this.statusEl.setText("🎙 就绪");
		this.statusEl.setAttribute("aria-label", "语音待办：点击开始 / 停止录音");
		this.registerDomEvent(this.statusEl, "click", () => {
			void this.toggleRecording();
		});

		this.addRibbonIcon("mic", "语音待办：开始 / 停止录音", () => {
			void this.toggleRecording();
		});

		this.addCommand({
			id: "toggle-recording",
			name: "开始 / 停止录音",
			callback: () => void this.toggleRecording(),
		});

		this.addCommand({
			id: "stop-recording",
			name: "停止录音并保存",
			callback: () => void this.stopRecording(),
		});

		this.addCommand({
			id: "transcribe-note-audio",
			name: "转写当前笔记里的音频",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md" || !Platform.isDesktopApp) return false;
				if (!checking) void this.transcribeNoteAudio(file);
				return true;
			},
		});

		this.addCommand({
			id: "ai-polish-note",
			name: "AI 整理当前笔记（提要 / 正文 / 待办）",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.polishNote(file);
				return true;
			},
		});

		this.addCommand({
			id: "transcribe-note-cloud",
			name: "用云端转写当前笔记里的音频",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.transcribeNoteAudio(file, "cloud");
				return true;
			},
		});

		this.addCommand({
			id: "aggregate-todos",
			name: "汇总待办到 Todo 笔记",
			callback: () => void this.aggregateTodos(),
		});

		this.addCommand({
			id: "write-diagnostic-report",
			name: "生成诊断报告",
			callback: () => void this.writeDiagnosticReport(),
		});

		this.addCommand({
			id: "test-cloud-connectivity",
			name: "测试云端转写连通",
			callback: () => void this.testCloudConnectivity(),
		});

		this.addCommand({
			id: "open-last-audio",
			name: "打开最近一段录音",
			checkCallback: (checking: boolean) => {
				if (!this.lastAudioPath) return false;
				if (!checking) {
					const file = this.app.vault.getAbstractFileByPath(this.lastAudioPath);
					if (file instanceof TFile) void this.app.workspace.getLeaf(true).openFile(file);
				}
				return true;
			},
		});

		this.addSettingTab(new VoiceTodoSettingTab(this.app, this));

		this.registerMarkdownPostProcessor((el, ctx) => this.addRetryButton(el, ctx.sourcePath));

		// 桌面端兜底：手机没配云端转写 key、或云端请求被打断时，笔记会停在「⏳ 转写中」。
		// 这里启动后扫一遍，之后每 10 分钟一次，用本地 whisper 补转。
		this.app.workspace.onLayoutReady(() => {
			void this.sweepPendingNotes();
		});
		this.registerInterval(window.setInterval(() => void this.sweepPendingNotes(), 10 * 60 * 1000));
	}

	onunload(): void {
		this.clearTimer();
		this.recorder.abort();
	}

	private async toggleRecording(): Promise<void> {
		if (this.recorder.isRecording) {
			await this.stopRecording();
			return;
		}
		await this.startRecording();
	}

	private async startRecording(): Promise<void> {
		if (this.recorder.isRecording) return;
		try {
			await this.recorder.start();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`无法开始录音：${msg}\n请检查系统麦克风权限和输入设备。`, 8000);
			console.error("[voice-todo] start failed", err);
			return;
		}
		this.statusEl?.addClass("is-recording");
		this.statusEl?.setText("🎙 00:00");
		this.startTimer();
		new Notice("开始录音");
	}

	private async stopRecording(): Promise<void> {
		if (!this.recorder.isRecording) return;
		this.clearTimer();
		this.statusEl?.removeClass("is-recording");
		this.statusEl?.setText("⏳ 保存中");

		let result: RecordingResult;
		try {
			result = await this.recorder.stop();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.statusEl?.setText("🎙 就绪");
			new Notice(`录音失败：${msg}`, 8000);
			console.error("[voice-todo] stop failed", err);
			return;
		}

		try {
			const saved = await this.saveAudio(result);
			this.lastAudioPath = saved.path;
			const marker = newMarker();
			const target = await this.attachAudio(saved.path, saved.name, result, marker);
			new Notice(`已保存：${saved.path}`);
			if (this.settings.autoTranscribe && target) {
				void this.runTranscription(target, saved.path, marker);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`保存失败：${msg}`, 8000);
			console.error("[voice-todo] save failed", err);
		} finally {
			this.statusEl?.setText("🎙 就绪");
		}
	}

	private async saveAudio(result: RecordingResult): Promise<{ path: string; name: string }> {
		const baseFolder = trimSlashes(this.settings.audioFolder) || "附件/录音";
		const folder = Platform.isDesktopApp
			? normalizePath(`${baseFolder}/${moment().format("YYYY")}`)
			: normalizePath(`${baseFolder}/_mobile`);
		await this.ensureFolder(folder);

		const stamp = moment().format("YYYYMMDD-HHmmss");
		let name = `${stamp}.${result.ext}`;
		let path = normalizePath(`${folder}/${name}`);
		let i = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			name = `${stamp}-${i}.${result.ext}`;
			path = normalizePath(`${folder}/${name}`);
			i += 1;
		}

		await this.app.vault.createBinary(path, await result.blob.arrayBuffer());
		return { path, name };
	}

	/** 把音频写进笔记，返回目标文件和占位标记 */
	private async attachAudio(
		audioPath: string,
		name: string,
		result: RecordingResult,
		marker: string,
	): Promise<TFile | null> {
		const embed = Platform.isDesktopApp
			? `![[${audioPath}]]`
			: "> 手机录音，转写成功后音频会自动删除。";
		const placeholder = `%%${marker}%%\n> ⏳ 转写中…`;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (view?.file && this.settings.insertIntoActiveNote) {
			view.editor.replaceSelection(`\n\n${embed}\n\n${placeholder}\n`);
			return view.file;
		}

		const year = moment().format("YYYY");
		const baseFolder = trimSlashes(this.settings.noteFolder) || "语音笔记";
		const folder = normalizePath(`${baseFolder}/${year}`);
		await this.ensureFolder(folder);

		const stamp = moment().format("YYYY-MM-DD HHmmss");
		let notePath = normalizePath(`${folder}/${stamp} 语音.md`);
		let i = 2;
		while (this.app.vault.getAbstractFileByPath(notePath)) {
			notePath = normalizePath(`${folder}/${stamp} 语音 ${i}.md`);
			i += 1;
		}

		const frontmatter = [
			"---",
			`created: ${moment().format()}`,
			"source: voice",
			`duration: ${formatDuration(result.durationMs)}`,
		];
		frontmatter.push(`audio: "${audioPath}"`);
		frontmatter.push("---");

		const content = [
			...frontmatter,
			"",
			embed,
			"",
			"## 转写",
			"",
			placeholder,
			"",
		].join("\n");

		void name;
		const file = await this.app.vault.create(notePath, content);
		await this.app.workspace.getLeaf(true).openFile(file);
		return file;
	}

	private async runTranscription(file: TFile, audioPath: string, marker: string): Promise<void> {
		if (this.busy) {
			new Notice("上一条还在转写，稍后再试");
			return;
		}
		this.busy = true;
		this.statusEl?.setText("📝 转写中");
		try {
			// 手机端只能走云端；没配 key 时不写死错误，留一个「等电脑补转」的占位，
			// 音频和 audio 字段都保留，桌面端的定时扫描会用本地 whisper 补上。
			if (!Platform.isDesktopApp && !this.getAsrKey()) {
				await this.replacePlaceholder(file, marker, "> ⏸ 手机未配置云端转写 key，等电脑补转（音频已保留）", true);
				return;
			}
			const raw = await this.transcribeAudio(audioPath);
			const text = this.settings.stripEmoji ? stripEmoji(raw) : raw;
			await this.replacePlaceholder(file, marker, text || "（没有识别到语音）");
			if (!Platform.isDesktopApp) await this.removeAudio(audioPath);
			new Notice("转写完成");
			if (this.settings.autoPolish && this.getApiKey()) {
				await this.runPolish(file, text);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await this.replacePlaceholder(file, marker, `> ⚠️ 转写失败：${msg}`, true);
			new Notice(`转写失败：${msg}`, 8000);
			this.diag(`转写失败（${file.path}）：${msg}`);
			console.error("[voice-todo] transcribe failed", err);
		} finally {
			this.busy = false;
			this.statusEl?.setText("🎙 就绪");
		}
	}

	/** 手动转写当前笔记里第一个音频嵌入 */
	private async transcribeNoteAudio(file: TFile, force: "local" | "cloud" | null = null): Promise<void> {
		const content = await this.app.vault.read(file);
		const audioPath = this.resolveAudioPath(content, file.path);
		if (!audioPath) {
			new Notice("这条笔记里没找到音频（没有 ![[xxx.webm]] 嵌入，frontmatter 也没有 audio 字段）");
			return;
		}

		new Notice("开始转写…");
		try {
			const raw = await this.transcribeAudio(audioPath, force);
			const text = this.settings.stripEmoji ? stripEmoji(raw) : raw;
			await this.writeTranscriptSection(file, text || "（没有识别到语音）");
			new Notice("转写完成");
			if (this.settings.autoPolish && this.getApiKey()) {
				await this.runPolish(file, text);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`转写失败：${msg}`, 8000);
			this.diag(`笔记转写失败（${file.path}）：${msg}`);
			console.error("[voice-todo] transcribe note failed", err);
		}
	}

	private async replacePlaceholder(
		file: TFile,
		marker: string,
		text: string,
		isError = false,
	): Promise<void> {
		const block = `%%${marker}%%\n> ⏳ 转写中…`;
		const replacement = `${text}\n`;

		let current = await this.app.vault.read(file);
		if (!current.includes(block)) {
			// 刚插进编辑器时磁盘上可能还没写下去，等一拍再读
			await new Promise((r) => window.setTimeout(r, 1500));
			current = await this.app.vault.read(file);
		}
		const next = current.includes(block)
			? current.replace(block, replacement)
			: `${current.replace(/\s*$/, "")}\n\n${replacement}`;
		await this.app.vault.modify(file, next);
	}

	private async writeTranscriptSection(file: TFile, text: string): Promise<void> {
		const current = await this.app.vault.read(file);
		const section = /(\n## 转写\s*\n)([\s\S]*?)(?=\n## |\s*$)/;
		let next: string;
		if (section.test(current)) {
			next = current.replace(section, `$1\n${text}\n`);
		} else {
			next = `${current.replace(/\s*$/, "")}\n\n## 转写\n\n${text}\n`;
		}
		await this.app.vault.modify(file, next.replace(/\n{3,}/g, "\n\n"));
	}

	private async writeAiError(file: TFile, msg: string): Promise<void> {
		const line = `<!-- vt:ai:error -->\n> ⚠️ 整理失败：${msg}`;
		const current = await this.app.vault.read(file);
		const region = /<!-- vt:ai:error -->\n>[^\n]*/;
		let next: string;
		if (region.test(current)) {
			next = current.replace(region, line);
		} else {
			const idx = current.indexOf("## 转写");
			next =
				idx >= 0
					? `${current.slice(0, idx)}${line}\n\n${current.slice(idx)}`
					: `${current.replace(/\s*$/, "")}\n\n${line}\n`;
		}
		await this.app.vault.modify(file, next);
	}

	/** 云端请求本身没有超时，挂起后会把 busy 永久钉死；统一套一层超时 */
	private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
		return Promise.race([
			p,
			new Promise<never>((_, reject) =>
				window.setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`)), ms),
			),
		]);
	}

	/** 依次尝试：嵌入链接 → frontmatter 的 audio → 按笔记名里的时间戳猜 _mobile / 年份目录 */
	private resolveAudioPath(content: string, notePath: string): string | null {
		const embed = content.match(/!\[\[([^\]|#]+?)\]\]/)?.[1]?.trim() ?? "";
		const fm = content.match(/\baudio:\s*"?([^"\n]+)"?/)?.[1]?.trim() ?? "";

		const candidates: string[] = [];
		if (embed && AUDIO_EXT.test(embed)) candidates.push(embed);
		if (fm && AUDIO_EXT.test(fm)) candidates.push(fm);

		const stamp = notePath.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2})(\d{2})(\d{2})/);
		if (stamp) {
			const year = stamp[1];
			const id = `${stamp[1]}${stamp[2]}${stamp[3]}-${stamp[4]}${stamp[5]}${stamp[6]}`;
			const base = trimSlashes(this.settings.audioFolder) || "附件/录音";
			for (const ext of ["webm", "m4a", "mp3", "wav", "ogg", "opus", "mp4"]) {
				candidates.push(`${base}/_mobile/${id}.${ext}`, `${base}/${year}/${id}.${ext}`);
			}
		}

		for (const candidate of candidates) {
			const direct = this.app.vault.getAbstractFileByPath(normalizePath(candidate));
			if (direct instanceof TFile) return direct.path;
			const dest = this.app.metadataCache.getFirstLinkpathDest(candidate, notePath);
			if (dest) return dest.path;
		}
		return null;
	}

	/** 桌面端兜底：扫「语音笔记」里停住的条目，用本地 whisper 补转 */
	private async sweepPendingNotes(): Promise<void> {
		if (!Platform.isDesktopApp || this.busy) return;
		const folder = normalizePath(trimSlashes(this.settings.noteFolder) || "语音笔记");
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path === folder || f.path.startsWith(`${folder}/`));

		for (const file of files) {
			if (this.busy) return;
			// 刚写入的笔记可能正在被手机端或本机处理，先放过
			if (Date.now() - file.stat.mtime < 90_000) continue;
			const content = await this.app.vault.read(file);
			if (!content.includes("⏳ 转写中") && !content.includes("等电脑补转")) continue;
			const audioPath = this.resolveAudioPath(content, file.path);
			if (!audioPath) continue;
			await this.transcribeQueuedFile(file, audioPath);
		}
	}

	private async transcribeQueuedFile(file: TFile, audioPath: string): Promise<void> {
		this.busy = true;
		this.statusEl?.setText("📝 补转中");
		try {
			const raw = await this.transcribeAudio(audioPath, "local");
			const text = this.settings.stripEmoji ? stripEmoji(raw) : raw;
			await this.writeTranscriptSection(file, text || "（没有识别到语音）");
			console.log(`[voice-todo] 补转完成：${file.path}`);
			if (this.settings.autoPolish && this.getApiKey()) {
				await this.runPolish(file, text);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.diag(`补转失败（${file.path}）：${msg}`);
			console.error("[voice-todo] 补转失败", file.path, err);
		} finally {
			this.busy = false;
			this.statusEl?.setText("🎙 就绪");
		}
	}

	private async openReport(prefix: string, body: string): Promise<void> {
		const path = normalizePath(`${prefix} ${moment().format("YYYY-MM-DD HHmmss")}.md`);
		try {
			const file = await this.app.vault.create(path, `${body}\n`);
			await this.app.workspace.getLeaf(true).openFile(file);
			new Notice(`报告已生成：${path}`, 6000);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`报告写入失败：${msg}`, 8000);
			this.diag(`报告写入失败：${msg}`);
		}
	}

	/** 诊断报告：配置 + 目录状态 + 待转写条目 + 最近错误。纯本地，不发任何网络请求 */
	async writeDiagnosticReport(): Promise<void> {
		const s = this.settings;
		const audioBase = normalizePath(trimSlashes(s.audioFolder) || "附件/录音");
		const noteFolder = normalizePath(trimSlashes(s.noteFolder) || "语音笔记");
		const all = this.app.vault.getFiles();
		const audioFiles = all.filter((f) => f.path.startsWith(`${audioBase}/`) && AUDIO_EXT.test(f.path));
		const mobileAudio = audioFiles.filter((f) => f.path.includes("/_mobile/"));
		const audioBytes = audioFiles.reduce((sum, f) => sum + f.stat.size, 0);
		const notes = all.filter(
			(f) => f.extension === "md" && (f.path === noteFolder || f.path.startsWith(`${noteFolder}/`)),
		);

		const out: string[] = [];
		out.push("# 语音待办 诊断报告", "");
		out.push(`- 生成时间：${moment().format("YYYY-MM-DD HH:mm:ss")}`);
		out.push(`- 平台：${Platform.isDesktopApp ? "桌面端" : "移动端"}`);
		out.push(`- 插件版本：${this.manifest.version}`);
		out.push(`- 仓库：${this.app.vault.getName()}`);
		out.push(`- 报告不含任何 API Key，也不含笔记正文和转写内容`, "");

		out.push("## 转写配置", "");
		out.push(`- 停录后自动转写：${s.autoTranscribe ? "开" : "关"}`);
		out.push(`- 转写引擎：${s.transcribeEngine}（手机端强制走云端）`);
		out.push(`- 云端接口地址：${s.cloudBaseUrl}`);
		out.push(`- 云端模型：${s.cloudModel}`);
		out.push(`- 云端转写 key：${this.getAsrKey() ? "已配置" : "未配置"}`);
		out.push(`- DeepSeek key（AI 整理）：${this.hasApiKey() ? "已配置" : "未配置"}`);
		out.push(`- 转写后自动整理：${s.autoPolish ? "开" : "关"}`);
		out.push(`- 本地模型：${s.whisperModel} / 语言 ${s.whisperLang}`);
		out.push("");

		if (Platform.isDesktopApp) {
			out.push("## 本机工具链（仅桌面端）", "");
			try {
				const req = (window as unknown as { require?: (m: string) => unknown }).require;
				const fs = req ? (req("fs") as typeof import("fs")) : null;
				if (!fs) out.push("- 拿不到 fs 模块，跳过路径检查");
				else {
					const check = (label: string, p: string) =>
						out.push(`- ${label}：${p} ${fs.existsSync(p) ? "✅" : "❌ 不存在"}`);
					check("python.exe", s.pythonPath);
					check("转写脚本", s.scriptPath);
					check("ffmpeg 目录", s.ffmpegDir);
					check("ASR 数据目录", s.asrHome);
				}
			} catch (err) {
				out.push(`- 读取本机路径失败：${err instanceof Error ? err.message : String(err)}`);
			}
			out.push("");
		}

		out.push("## 目录与文件", "");
		out.push(`- 录音目录：${audioBase} ${this.app.vault.getAbstractFileByPath(audioBase) ? "✅" : "❌ 不存在"}`);
		out.push(`- 语音笔记目录：${noteFolder} ${this.app.vault.getAbstractFileByPath(noteFolder) ? "✅" : "❌ 不存在"}`);
		out.push(`- 音频文件：${audioFiles.length} 个，共 ${(audioBytes / 1024 / 1024).toFixed(1)} MB（其中 _mobile/ 下 ${mobileAudio.length} 个）`);
		out.push(`- 笔记条数：${notes.length}`);
		out.push("");

		out.push("## 待转写 / 失败的条目", "");
		let pendingCount = 0;
		for (const note of notes) {
			const content = await this.app.vault.read(note);
			const state = content.includes("⏳ 转写中")
				? "⏳ 卡在转写中"
				: content.includes("等电脑补转")
					? "⏸ 等电脑补转"
					: content.includes("转写失败")
						? "⚠️ 转写失败"
						: content.includes("## 转写")
							? "✅ 有转写"
							: "（无转写段）";
			if (state.startsWith("✅") || state.startsWith("（")) continue;
			pendingCount += 1;
			if (pendingCount > 20) continue;
			const audio = this.resolveAudioPath(content, note.path);
			out.push(
				`- ${moment(note.stat.mtime).format("MM-DD HH:mm")} ｜ ${note.path} ｜ ${state} ｜ 音频：${audio ?? "❌ 找不到"}`,
			);
		}
		if (pendingCount === 0) out.push("- 没有卡住的条目");
		out.push("");

		out.push("## 最近错误（内存，刷新后清空）", "");
		if (this.diagLog.length === 0) out.push("- 无");
		else for (const line of this.diagLog.slice(-30)) out.push(`- ${line}`);

		await this.openReport("语音待办 诊断报告", out.join("\n"));
	}

	/** 测试云端连通：先拉模型列表验 key，再用 0.4 秒静音音频真跑一次转写 */
	async testCloudConnectivity(): Promise<void> {
		const s = this.settings;
		const base = (s.cloudBaseUrl || DEFAULT_SETTINGS.cloudBaseUrl).replace(/\/+$/, "");
		const model = s.cloudModel || DEFAULT_SETTINGS.cloudModel;
		const key = this.getAsrKey();

		const out: string[] = [];
		out.push("# 语音待办 云端连通测试", "");
		out.push(`- 时间：${moment().format("YYYY-MM-DD HH:mm:ss")}`);
		out.push(`- 平台：${Platform.isDesktopApp ? "桌面端" : "移动端"}`);
		out.push(`- 接口地址：${base}`);
		out.push(`- 模型：${model}`);
		out.push(
			`- API Key：${key ? `已配置（${key.slice(0, 3)}…${key.slice(-2)}，共 ${key.length} 位）` : "未配置"}`,
		);
		out.push("");

		if (!key) {
			out.push("## 结论", "", "❌ 没有 API Key，没法测。去「设置 → 语音待办 → 云端转写 → 云端转写 API Key」填一个。");
			await this.openReport("语音待办 连通测试", out.join("\n"));
			return;
		}

		const t1 = Date.now();
		try {
			const resp = await this.withTimeout(
				requestUrl({
					url: `${base}/models`,
					method: "GET",
					headers: { Authorization: `Bearer ${key}` },
					throw: false,
				}),
				15_000,
				"拉取模型列表",
			);
			out.push("## 1. 鉴权与网络（GET /models）", "", `- 状态码：${resp.status}`, `- 耗时：${Date.now() - t1} ms`);
			if (resp.status >= 400) {
				out.push(`- 返回片段：${(resp.text || "").slice(0, 300)}`);
				out.push("- 结论：❌ key 或接口地址不对");
			} else {
				out.push("- 结论：✅ 网络通、key 被接受");
			}
		} catch (err) {
			out.push(
				"## 1. 鉴权与网络（GET /models）",
				"",
				`- ❌ ${err instanceof Error ? err.message : String(err)}`,
				`- 耗时：${Date.now() - t1} ms`,
			);
		}

		const t2 = Date.now();
		try {
			const text = await this.withTimeout(
				transcribeCloud({
					baseUrl: base,
					apiKey: key,
					model,
					audio: buildSilentWav(),
					filename: "silence.wav",
					mime: "audio/wav",
					language: undefined,
				}),
				60_000,
				"云端转写接口",
			);
			out.push("", "## 2. 转写接口（POST /audio/transcriptions）", "");
			out.push(`- 耗时：${Date.now() - t2} ms`);
			out.push(`- 返回文本：${text ? `「${text}」` : "（空，静音音频属正常）"}`);
			out.push("- 结论：✅ 整条链路可用");
			new Notice("云端转写连通：正常");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			out.push("", "## 2. 转写接口（POST /audio/transcriptions）", "");
			out.push(`- ❌ ${msg}`);
			out.push(`- 耗时：${Date.now() - t2} ms`);
			new Notice(`云端转写失败：${msg}`, 8000);
			this.diag(`云端连通测试失败：${msg}`);
		}

		await this.openReport("语音待办 连通测试", out.join("\n"));
	}

	/** 把扫描目录里的未完成待办汇总到 Todo 笔记，按文本去重 */
	private async aggregateTodos(): Promise<void> {
		const folder = normalizePath(trimSlashes(this.settings.todoScanFolder) || "语音笔记");
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path === folder || f.path.startsWith(`${folder}/`));
		if (files.length === 0) {
			new Notice(`「${folder}」里没有笔记`);
			return;
		}

		const todoPath = normalizePath(trimSlashes(this.settings.todoFilePath) || "Todo.md");
		let target = this.app.vault.getAbstractFileByPath(todoPath);
		if (!(target instanceof TFile)) {
			const parent = todoPath.includes("/") ? todoPath.slice(0, todoPath.lastIndexOf("/")) : "";
			if (parent) await this.ensureFolder(parent);
			target = await this.app.vault.create(todoPath, "# 待办\n");
		}
		const todoFile = target as TFile;
		const existing = await this.app.vault.read(todoFile);

		const known = new Set<string>();
		for (const m of existing.matchAll(/^- \[[ xX]\] (.+)$/gm)) {
			known.add(normalizeTaskText(m[1]));
		}

		const added: Array<{ text: string; source: string }> = [];
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
			new Notice("没有新的待办");
			return;
		}

		const today = moment().format("YYYY-MM-DD");
		const heading = `## ${today}`;
		const newLines = added.map((a) => `- [ ] ${a.text} ← [[${a.source}]]`);
		const lines = existing.split("\n");
		const idx = lines.findIndex((l) => l.trim() === heading);

		let out: string[];
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
		new Notice(`新增 ${added.length} 条待办 → ${todoPath}`);
	}

	private getSecretStore(): { getSecret(id: string): string | null; setSecret(id: string, v: string): void } | null {
		const app = this.app as unknown as {
			secretStorage?: { getSecret(id: string): string | null; setSecret(id: string, v: string): void };
		};
		return app.secretStorage ?? null;
	}

	private readSecret(id: string): string {
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

	private writeSecret(id: string, value: string): boolean {
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

	getApiKey(): string {
		return this.readSecret(DEEPSEEK_SECRET_ID) || (this.settings.deepseekApiKey || "").trim();
	}

	saveApiKey(value: string): boolean {
		return this.writeSecret(DEEPSEEK_SECRET_ID, value);
	}

	getAsrKey(): string {
		return this.readSecret(ASR_SECRET_ID) || (this.settings.cloudApiKey || "").trim();
	}

	saveAsrKey(value: string): boolean {
		return this.writeSecret(ASR_SECRET_ID, value);
	}

	hasApiKey(): boolean {
		return this.getApiKey().length > 0;
	}

	private async transcribeAudio(vaultPath: string, force: "local" | "cloud" | null = null): Promise<string> {
		const engine = force ?? (Platform.isDesktopApp ? this.settings.transcribeEngine : "cloud");
		if (engine === "cloud") return this.transcribeCloudFile(vaultPath);
		return this.transcriber.transcribe(this.absolute(vaultPath));
	}

	private async transcribeCloudFile(vaultPath: string): Promise<string> {
		const key = this.getAsrKey();
		if (!key) throw new Error("还没配置云端转写 API Key（设置 → 语音待办 → 云端转写）");
		const audio = await this.app.vault.adapter.readBinary(vaultPath);
		const filename = vaultPath.split("/").pop() || "audio.webm";
		const mime = filename.endsWith(".m4a")
			? "audio/mp4"
			: filename.endsWith(".mp3")
				? "audio/mpeg"
				: filename.endsWith(".wav")
					? "audio/wav"
					: filename.endsWith(".ogg")
						? "audio/ogg"
						: "audio/webm";
		return this.withTimeout(
			transcribeCloud({
				baseUrl: this.settings.cloudBaseUrl,
				apiKey: key,
				model: this.settings.cloudModel,
				audio,
				filename,
				mime,
				language: this.settings.whisperLang === "auto" ? undefined : this.settings.whisperLang,
			}),
			120_000,
			"云端转写",
		);
	}

	/** 在「整理失败 / 转写失败」提示后面挂一个重试按钮 */
	private addRetryButton(el: HTMLElement, sourcePath: string): void {
		const candidates = Array.from(el.querySelectorAll("p, blockquote, .callout, .callout-content"));
		for (const node of candidates) {
			const text = node.textContent ?? "";
			if (!text.includes("整理失败") && !text.includes("转写失败") && !text.includes("⏳ 转写中")) continue;
			if (node.querySelector("button.vt-retry")) return;
			const btn = document.createElement("button");
			btn.className = "vt-retry";
			btn.textContent = "重试";
			btn.addEventListener("click", (ev) => {
				ev.preventDefault();
				void this.retryNote(sourcePath);
			});
			node.appendChild(btn);
			return;
		}
	}

	private async retryNote(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const content = await this.app.vault.read(file);

		if (content.includes("整理失败") || content.includes("<!-- vt:ai:error -->")) {
			const match = content.match(/\n## 转写\s*\n([\s\S]*?)(?=\n## |\s*$)/);
			const transcript = match?.[1]?.trim() ?? "";
			if (transcript) {
				await this.runPolish(file, transcript);
				return;
			}
		}

		if (content.includes("转写失败") || content.includes("⏳ 转写中")) {
			await this.transcribeNoteAudio(file);
		}
	}

	private async polishNote(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		const match = content.match(/\n## 转写\s*\n([\s\S]*?)(?=\n## |\s*$)/);
		const transcript = match?.[1]?.trim() ?? "";
		if (!transcript) {
			new Notice("这条笔记里没有「## 转写」内容");
			return;
		}
		await this.runPolish(file, transcript);
	}

	private async runPolish(file: TFile, transcript: string): Promise<void> {
		const apiKey = this.getApiKey();
		if (!apiKey) {
			await this.writeAiError(file, "还没配置 DeepSeek API Key（设置 → 语音待办 → AI 整理）");
			new Notice("还没配置 DeepSeek API Key（设置 → 语音待办）");
			return;
		}
		if (!transcript.trim()) return;

		this.statusEl?.setText("🤖 整理中");
		try {
			const result = await polishTranscript({
				apiKey,
				baseUrl: this.settings.deepseekBaseUrl,
				model: this.settings.deepseekModel,
				transcript,
			});
			await this.applyAiBlock(file, result);
			new Notice("整理完成");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await this.writeAiError(file, msg);
			new Notice(`整理失败：${msg}`, 8000);
			console.error("[voice-todo] polish failed", err);
		} finally {
			this.statusEl?.setText("🎙 就绪");
		}
	}

	private async applyAiBlock(file: TFile, result: PolishResult): Promise<void> {
		const parts: string[] = [];
		if (result.summary) parts.push(`## 提要\n\n${result.summary}`);
		if (result.body) parts.push(`## 正文\n\n${result.body}`);
		if (result.todos.length > 0) {
			parts.push(`## 待办\n\n${result.todos.map((t) => `- [ ] ${t}`).join("\n")}`);
		}
		if (parts.length === 0) return;

		const block = `<!-- vt:ai:start -->\n${parts.join("\n\n")}\n<!-- vt:ai:end -->`;
		const current = await this.app.vault.read(file);
		const region = /<!-- vt:ai:start -->[\s\S]*?<!-- vt:ai:end -->/;

		let next: string;
		if (region.test(current)) {
			next = current.replace(region, block);
		} else {
			const idx = current.indexOf("## 转写");
			next =
				idx >= 0
					? `${current.slice(0, idx)}${block}\n\n${current.slice(idx)}`
					: `${current.replace(/\s*$/, "")}\n\n${block}\n`;
		}
		await this.app.vault.modify(file, next.replace(/<!-- vt:ai:error -->\n>[^\n]*\n?/, ""));

		if (result.title) {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm.ai_title = result.title;
			});
			if (this.settings.renameNoteByTitle) await this.renameByTitle(file, result.title);
		}
	}

	private async renameByTitle(file: TFile, title: string): Promise<void> {
		const clean = sanitizeTitle(title);
		if (!clean || /无法|未知|未识别/.test(clean)) return;
		const match = file.basename.match(/^(\d{4}-\d{2}-\d{2}) (\d{6})/);
		const prefix = match
			? `${match[1]} ${match[2]}`
			: moment(file.stat.ctime).format("YYYY-MM-DD HHmmss");
		const parent = file.parent?.path;
		const folder = parent && parent !== "/" ? `${parent}/` : "";
		const target = normalizePath(`${folder}${prefix} ${clean}.md`);
		if (target === file.path) return;
		if (this.app.vault.getAbstractFileByPath(target)) return;
		try {
			await this.app.fileManager.renameFile(file, target);
		} catch (err) {
			console.error("[voice-todo] rename failed", err);
		}
	}

	private async removeAudio(vaultPath: string): Promise<void> {
		try {
			const file = this.app.vault.getAbstractFileByPath(vaultPath);
			if (file) await this.app.vault.delete(file);
		} catch (err) {
			console.error("[voice-todo] delete audio failed", err);
		}
	}

	private absolute(vaultPath: string): string {
		const adapter = this.app.vault.adapter as unknown as {
			getFullPath?: (p: string) => string;
		};
		if (typeof adapter.getFullPath === "function") return adapter.getFullPath(vaultPath);
		return vaultPath;
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = normalizePath(path).split("/").filter(Boolean);
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

	private startTimer(): void {
		this.clearTimer();
		this.timerId = window.setInterval(() => {
			this.statusEl?.setText(`🎙 ${formatDuration(this.recorder.elapsedMs)}`);
		}, 500);
	}

	private clearTimer(): void {
		if (this.timerId !== null) {
			window.clearInterval(this.timerId);
			this.timerId = null;
		}
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<VoiceTodoSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class VoiceTodoSettingTab extends PluginSettingTab {
	plugin: VoiceTodoPlugin;

	constructor(app: App, plugin: VoiceTodoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("保存").setHeading();

		new Setting(containerEl)
			.setName("录音保存目录")
			.setDesc("相对仓库根目录，按年份自动建子目录。")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.audioFolder)
					.setValue(this.plugin.settings.audioFolder)
					.onChange(async (value) => {
						this.plugin.settings.audioFolder = value || DEFAULT_SETTINGS.audioFolder;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("独立笔记目录")
			.setDesc("没有打开的笔记时，录音会新建一条笔记放在这里。")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.noteFolder)
					.setValue(this.plugin.settings.noteFolder)
					.onChange(async (value) => {
						this.plugin.settings.noteFolder = value || DEFAULT_SETTINGS.noteFolder;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("录到当前笔记")
			.setDesc("打开着笔记时，把音频链接插到光标处；关闭则永远新建笔记。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.insertIntoActiveNote).onChange(async (value) => {
					this.plugin.settings.insertIntoActiveNote = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("转写（仅桌面端）").setHeading();

		new Setting(containerEl)
			.setName("停录后自动转写")
			.setDesc("用本机 faster-whisper，不联网、不花钱。手机端不支持。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoTranscribe).onChange(async (value) => {
					this.plugin.settings.autoTranscribe = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("python.exe 路径")
			.setDesc("DSH 运行时自带的 Python，装了 faster-whisper。")
			.addText((text) =>
				text.setValue(this.plugin.settings.pythonPath).onChange(async (value) => {
					this.plugin.settings.pythonPath = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("转写脚本路径")
			.setDesc("video-transcribe 技能里的 video_transcribe.py。")
			.addText((text) =>
				text.setValue(this.plugin.settings.scriptPath).onChange(async (value) => {
					this.plugin.settings.scriptPath = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("ffmpeg 目录")
			.setDesc("内含 ffmpeg.exe 的目录，脚本靠它抽音轨。")
			.addText((text) =>
				text.setValue(this.plugin.settings.ffmpegDir).onChange(async (value) => {
					this.plugin.settings.ffmpegDir = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("转写模型")
			.setDesc("small 够用；medium 更准但慢。")
			.addDropdown((dd) =>
				dd
					.addOptions({
						tiny: "tiny",
						base: "base",
						small: "small",
						medium: "medium",
						"large-v3": "large-v3",
					})
					.setValue(this.plugin.settings.whisperModel)
					.onChange(async (value) => {
						this.plugin.settings.whisperModel = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("音频语言")
			.setDesc("保持 auto，强制 zh 会让英文音频出乱码。")
			.addDropdown((dd) =>
				dd
					.addOptions({ auto: "auto", zh: "中文", en: "英文", ja: "日文" })
					.setValue(this.plugin.settings.whisperLang)
					.onChange(async (value) => {
						this.plugin.settings.whisperLang = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("清理转写里的表情符号")
			.setDesc("云端口语模型会往文本里塞表情和情感标记，默认删掉，不改文字。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.stripEmoji).onChange(async (value) => {
					this.plugin.settings.stripEmoji = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("云端转写（手机端必用）").setHeading();

		new Setting(containerEl)
			.setName("转写引擎")
			.setDesc("本地更快更省钱；手机端没有本地转写，会强制走云端。")
			.addDropdown((dd) =>
				dd
					.addOptions({ local: "本地 faster-whisper", cloud: "云端 OpenAI 兼容接口" })
					.setValue(this.plugin.settings.transcribeEngine)
					.onChange(async (value) => {
						this.plugin.settings.transcribeEngine = value as "local" | "cloud";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("云端接口地址")
			.setDesc("示例：硅基流动 https://api.siliconflow.cn/v1")
			.addText((text) =>
				text.setValue(this.plugin.settings.cloudBaseUrl).onChange(async (value) => {
					this.plugin.settings.cloudBaseUrl = value.trim() || DEFAULT_SETTINGS.cloudBaseUrl;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("云端模型名")
			.setDesc("硅基流动可填 FunAudioLLM/SenseVoiceSmall；其他服务按文档填。")
			.addText((text) =>
				text.setValue(this.plugin.settings.cloudModel).onChange(async (value) => {
					this.plugin.settings.cloudModel = value.trim() || DEFAULT_SETTINGS.cloudModel;
					await this.plugin.saveSettings();
				}),
			);

		let pendingAsrKey = "";
		const asrKeySetting = new Setting(containerEl)
			.setName("云端转写 API Key")
			.setDesc(
				this.plugin.getAsrKey()
					? "已配置（存于 SecretStorage）"
					: "和 DeepSeek 的 key 不是同一个，需要单独填。",
			);
		asrKeySetting.addText((text) => {
			text.setPlaceholder("sk-...").onChange((v) => {
				pendingAsrKey = v.trim();
			});
			text.inputEl.type = "password";
		});
		asrKeySetting.addButton((btn) =>
			btn.setButtonText("保存").onClick(async () => {
				if (!pendingAsrKey) {
					new Notice("先填 key");
					return;
				}
				if (this.plugin.saveAsrKey(pendingAsrKey)) {
					pendingAsrKey = "";
					new Notice("已保存到 SecretStorage");
					this.display();
					return;
				}
				this.plugin.settings.cloudApiKey = pendingAsrKey;
				await this.plugin.saveSettings();
				pendingAsrKey = "";
				new Notice("没有 SecretStorage，key 已写进 data.json");
				this.display();
			}),
		);

		new Setting(containerEl).setName("AI 整理（DeepSeek）").setHeading();

		let pendingKey = "";
		const keySetting = new Setting(containerEl)
			.setName("API Key")
			.setDesc(
				this.plugin.hasApiKey()
					? "已配置（存于 SecretStorage，不写进 data.json）"
					: "填 sk- 开头的 key，点「保存」。保存后这里不会回显。",
			);
		keySetting.addText((text) => {
			text.setPlaceholder("sk-...").onChange((v) => {
				pendingKey = v.trim();
			});
			text.inputEl.type = "password";
		});
		keySetting.addButton((btn) =>
			btn.setButtonText("保存").onClick(async () => {
				if (!pendingKey) {
					new Notice("先填 key");
					return;
				}
				if (this.plugin.saveApiKey(pendingKey)) {
					pendingKey = "";
					new Notice("已保存到 SecretStorage");
					this.display();
					return;
				}
				this.plugin.settings.deepseekApiKey = pendingKey;
				await this.plugin.saveSettings();
				pendingKey = "";
				new Notice("没有 SecretStorage，key 已写进 data.json，注意别同步出去");
				this.display();
			}),
		);

		new Setting(containerEl)
			.setName("转写后自动整理")
			.setDesc("转写完成自动跑一遍：提要、正文、待办。会产生少量 API 费用。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoPolish).onChange(async (value) => {
					this.plugin.settings.autoPolish = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("整理后按标题重命名")
			.setDesc("把「2026-10-31 234954 语音」改成「2026-10-31 234954 录音结束」。链接会自动更新。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.renameNoteByTitle).onChange(async (value) => {
					this.plugin.settings.renameNoteByTitle = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("模型")
			.setDesc("deepseek-chat 便宜够用；reasoner 更慢也更贵。")
			.addDropdown((dd) =>
				dd
					.addOptions({ "deepseek-chat": "deepseek-chat", "deepseek-reasoner": "deepseek-reasoner" })
					.setValue(this.plugin.settings.deepseekModel)
					.onChange(async (value) => {
						this.plugin.settings.deepseekModel = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("接口地址")
			.setDesc("默认官方地址；换中转时改这里。")
			.addText((text) =>
				text.setValue(this.plugin.settings.deepseekBaseUrl).onChange(async (value) => {
					this.plugin.settings.deepseekBaseUrl = value.trim() || DEFAULT_SETTINGS.deepseekBaseUrl;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("待办汇总").setHeading();

		new Setting(containerEl)
			.setName("Todo 笔记路径")
			.setDesc("汇总目标，不存在会自动创建；按待办文本去重，已勾选的不重复添加。")
			.addText((text) =>
				text.setValue(this.plugin.settings.todoFilePath).onChange(async (value) => {
					this.plugin.settings.todoFilePath = value.trim() || DEFAULT_SETTINGS.todoFilePath;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("扫描目录")
			.setDesc("只从这个目录（含子目录）里找未完成的 `- [ ]` 待办。")
			.addText((text) =>
				text.setValue(this.plugin.settings.todoScanFolder).onChange(async (value) => {
					this.plugin.settings.todoScanFolder = value.trim() || DEFAULT_SETTINGS.todoScanFolder;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("诊断（手机端也能用）").setHeading();

		new Setting(containerEl)
			.setName("生成诊断报告")
			.setDesc("把配置、目录状态、卡住的条目和最近错误写成一篇笔记放在仓库根目录。纯本地，不发网络请求。")
			.addButton((btn) =>
				btn.setButtonText("生成").onClick(() => void this.plugin.writeDiagnosticReport()),
			);

		new Setting(containerEl)
			.setName("测试云端连通")
			.setDesc("先拉一次模型列表验证 key，再用 0.4 秒静音音频真跑一次转写；共两个请求，不传你的录音。")
			.addButton((btn) =>
				btn.setButtonText("开始测试").onClick(() => void this.plugin.testCloudConnectivity()),
			);
	}
}
