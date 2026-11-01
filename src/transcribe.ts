import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { VoiceTodoSettings } from "./settings";

/**
 * 本地转写：调用 video-transcribe 技能里的脚本（faster-whisper）。
 * 只在桌面端可用，手机端走不了这条路。
 */
export class LocalWhisperTranscriber {
	constructor(private readonly getSettings: () => VoiceTodoSettings) {}

	async transcribe(audioAbsPath: string, timeoutMs = 15 * 60 * 1000): Promise<string> {
		const s = this.getSettings();
		if (!existsSync(s.pythonPath)) throw new Error(`找不到 Python：${s.pythonPath}`);
		if (!existsSync(s.scriptPath)) throw new Error(`找不到转写脚本：${s.scriptPath}`);
		if (!existsSync(audioAbsPath)) throw new Error(`找不到音频文件：${audioAbsPath}`);

		const outDir = await mkdtemp(join(tmpdir(), "voice-todo-"));
		const args = [
			s.scriptPath,
			audioAbsPath,
			"--out",
			outDir,
			"--model",
			s.whisperModel || "small",
			"--lang",
			s.whisperLang || "auto",
		];

		const env: NodeJS.ProcessEnv = { ...process.env };
		if (s.ffmpegDir) env.VIDEO_FFMPEG = s.ffmpegDir;
		if (s.asrHome) env.VIDEO_ASR_HOME = s.asrHome;

		try {
			await runProcess(s.pythonPath, args, env, timeoutMs);
			const produced = (await readdir(outDir)).filter((f) => f.toLowerCase().endsWith(".txt"));
			if (produced.length === 0) throw new Error("转写进程结束了，但没有产出文本");
			const text = await readFile(join(outDir, produced[0]), "utf8");
			return text.trim();
		} finally {
			await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

function runProcess(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let stderr = "";
		let stdout = "";
		let settled = false;

		const child = spawn(command, args, { env, windowsHide: true });

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			reject(new Error(`转写超时（${Math.round(timeoutMs / 60000)} 分钟）`));
		}, timeoutMs);

		child.stdout?.on("data", (buf: Buffer) => {
			stdout = (stdout + buf.toString("utf8")).slice(-4000);
		});
		child.stderr?.on("data", (buf: Buffer) => {
			stderr = (stderr + buf.toString("utf8")).slice(-4000);
		});

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`启动转写进程失败：${err.message}`));
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
			reject(new Error(`转写退出码 ${code}${detail ? `：${detail}` : ""}`));
		});
	});
}
