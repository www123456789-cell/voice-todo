export interface RecordingResult {
	blob: Blob;
	mimeType: string;
	ext: string;
	durationMs: number;
}

const MIME_CANDIDATES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/mp4;codecs=mp4a.40.2",
	"audio/mp4",
	"audio/ogg;codecs=opus",
];

function pickMimeType(): string {
	if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
		return "";
	}
	return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

function extForMime(mime: string): string {
	if (mime.includes("mp4")) return "m4a";
	if (mime.includes("ogg")) return "ogg";
	return "webm";
}

/**
 * 只管采集：拿到麦克风流、切块、停止时交出一个 Blob。
 * 不碰 vault，不碰 UI。
 */
export class VoiceRecorder {
	private mediaRecorder: MediaRecorder | null = null;
	private chunks: BlobPart[] = [];
	private stream: MediaStream | null = null;
	private startedAt = 0;
	private stopPromise: Promise<RecordingResult> | null = null;

	get isRecording(): boolean {
		return this.mediaRecorder !== null && this.mediaRecorder.state === "recording";
	}

	get elapsedMs(): number {
		return this.isRecording ? Date.now() - this.startedAt : 0;
	}

	async start(): Promise<void> {
		if (this.isRecording) throw new Error("已经在录音了");
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error("当前环境不支持 getUserMedia");
		}

		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				channelCount: 1,
			},
		});

		const mimeType = pickMimeType();
		try {
			this.mediaRecorder = mimeType
				? new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 128000 })
				: new MediaRecorder(this.stream);
		} catch (err) {
			this.releaseStream();
			throw err;
		}

		this.chunks = [];
		this.mediaRecorder.ondataavailable = (ev: BlobEvent) => {
			if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
		};
		this.mediaRecorder.onerror = (ev: Event) => {
			console.error("[voice-todo] MediaRecorder error", ev);
		};
		this.mediaRecorder.start(1000);
		this.startedAt = Date.now();
	}

	stop(): Promise<RecordingResult> {
		if (this.stopPromise) return this.stopPromise;
		const rec = this.mediaRecorder;
		if (!rec || rec.state === "inactive") {
			return Promise.reject(new Error("当前没有在录音"));
		}

		const durationMs = Date.now() - this.startedAt;
		this.stopPromise = new Promise<RecordingResult>((resolve, reject) => {
			rec.onstop = () => {
				try {
					const mimeType = rec.mimeType || "audio/webm";
					const blob = new Blob(this.chunks, { type: mimeType });
					this.chunks = [];
					this.mediaRecorder = null;
					this.stopPromise = null;
					this.releaseStream();
					if (blob.size === 0) {
						reject(new Error("录音为空（没有采到声音）"));
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
	abort(): void {
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

	private releaseStream(): void {
		if (this.stream) {
			this.stream.getTracks().forEach((t) => t.stop());
			this.stream = null;
		}
	}
}
