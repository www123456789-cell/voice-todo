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

export default class VoiceTodoPlugin extends Plugin {
	settings: VoiceTodoSettings = { ...DEFAULT_SETTINGS };

	private readonly recorder = new VoiceRecorder();
	private readonly transcriber = new LocalWhisperTranscriber(() => this.settings);
	private statusEl: HTMLElement | null = null;
	private timerId: number | null = null;
	private lastAudioPath: string | null = null;
	private busy = false;

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
			if (this.settings.autoTranscribe && Platform.isDesktopApp && target) {
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
		if (Platform.isDesktopApp) frontmatter.push(`audio: "${audioPath}"`);
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
			console.error("[voice-todo] transcribe failed", err);
		} finally {
			this.busy = false;
			this.statusEl?.setText("🎙 就绪");
		}
	}

	/** 手动转写当前笔记里第一个音频嵌入 */
	private async transcribeNoteAudio(file: TFile, force: "local" | "cloud" | null = null): Promise<void> {
		const content = await this.app.vault.read(file);
		const match = content.match(/!\[\[([^\]|#]+?)\]\].*?/);
		const link = match?.[1]?.trim();
		if (!link || !AUDIO_EXT.test(link)) {
			new Notice("这条笔记里没找到音频嵌入（![[xxx.webm]]）");
			return;
		}
		const dest = this.app.metadataCache.getFirstLinkpathDest(link, file.path);
		if (!dest) {
			new Notice(`找不到音频文件：${link}`);
			return;
		}

		new Notice("开始转写…");
		try {
			const raw = await this.transcribeAudio(dest.path, force);
			const text = this.settings.stripEmoji ? stripEmoji(raw) : raw;
			await this.writeTranscriptSection(file, text || "（没有识别到语音）");
			new Notice("转写完成");
			if (this.settings.autoPolish && this.getApiKey()) {
				await this.runPolish(file, text);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`转写失败：${msg}`, 8000);
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
		return transcribeCloud({
			baseUrl: this.settings.cloudBaseUrl,
			apiKey: key,
			model: this.settings.cloudModel,
			audio,
			filename,
			mime,
			language: this.settings.whisperLang === "auto" ? undefined : this.settings.whisperLang,
		});
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
	}
}
