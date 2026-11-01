export interface VoiceTodoSettings {
	/** 录音文件保存目录（相对 vault 根） */
	audioFolder: string;
	/** 独立笔记保存目录（没有打开笔记时使用） */
	noteFolder: string;
	/** 有打开的笔记时，直接把音频链接插到光标处 */
	insertIntoActiveNote: boolean;

	/** 停录后自动转写（仅桌面端） */
	autoTranscribe: boolean;
	/** DSH 运行时里的 python.exe */
	pythonPath: string;
	/** video-transcribe 技能里的转写脚本 */
	scriptPath: string;
	/** ffmpeg 目录（内含 ffmpeg.exe） */
	ffmpegDir: string;
	/** faster-whisper 与模型的根目录，空则用脚本默认值 */
	asrHome: string;
	/** tiny / base / small / medium / large-v3 */
	whisperModel: string;
	/** auto / zh / en / ja */
	whisperLang: string;

	/** 转写完成后自动 AI 整理 */
	autoPolish: boolean;
	/** DeepSeek 兼容接口根地址 */
	deepseekBaseUrl: string;
	/** deepseek-chat / deepseek-reasoner */
	deepseekModel: string;
	/** 旧版明文 key；正常情况下应存进 SecretStorage，这里保持空字符串 */
	deepseekApiKey: string;

	/** 汇总待办的目标文件 */
	todoFilePath: string;
	/** 只扫描这个目录下的笔记 */
	todoScanFolder: string;

	/** local / cloud（手机端强制走 cloud） */
	transcribeEngine: "local" | "cloud";
	/** 云端 ASR 根地址，OpenAI 兼容 */
	cloudBaseUrl: string;
	/** 云端 ASR 模型名 */
	cloudModel: string;
	/** 旧版明文 ASR key；正常应存 SecretStorage */
	cloudApiKey: string;

	/** 转写结果里去掉表情符号等噪音 */
	stripEmoji: boolean;
	/** 整理后按 AI 标题重命名笔记 */
	renameNoteByTitle: boolean;
}

const HOME = "C:\\Users\\theon";

export const DEFAULT_SETTINGS: VoiceTodoSettings = {
	audioFolder: "附件/录音",
	noteFolder: "语音笔记",
	insertIntoActiveNote: true,

	autoTranscribe: true,
	pythonPath: `${HOME}\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe`,
	scriptPath: `${HOME}\\.dsh\\skills\\video-transcribe\\scripts\\video_transcribe.py`,
	ffmpegDir: `${HOME}\\.dsh\\tools\\ffmpeg\\bin`,
	asrHome: `${HOME}\\Documents\\ChatGPT\\视频\\_asr`,
	whisperModel: "small",
	whisperLang: "auto",

	autoPolish: true,
	deepseekBaseUrl: "https://api.deepseek.com",
	deepseekModel: "deepseek-chat",
	deepseekApiKey: "",

	todoFilePath: "Todo.md",
	todoScanFolder: "语音笔记",

	transcribeEngine: "local",
	cloudBaseUrl: "https://api.siliconflow.cn/v1",
	cloudModel: "FunAudioLLM/SenseVoiceSmall",
	cloudApiKey: "",

	stripEmoji: true,
	renameNoteByTitle: true,
};

/** SecretStorage 里的 key 名 */
export const DEEPSEEK_SECRET_ID = "voice-todo-deepseek";
export const ASR_SECRET_ID = "voice-todo-asr";
