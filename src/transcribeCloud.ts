import { requestUrl } from "obsidian";

export interface CloudAsrOptions {
	baseUrl: string;
	apiKey: string;
	model: string;
	audio: ArrayBuffer;
	filename: string;
	mime: string;
	language?: string;
	timeoutMs?: number;
}

export interface MultipartPayload {
	body: Uint8Array;
	boundary: string;
	contentType: string;
}

/** 纯函数，方便脱离 Obsidian 单独验证 */
export function buildMultipart(opts: {
	fields: Record<string, string>;
	filename: string;
	mime: string;
	file: ArrayBuffer;
	boundary?: string;
}): MultipartPayload {
	const boundary = opts.boundary ?? `----voiceTodo${Math.random().toString(36).slice(2)}`;
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	const push = (text: string) => parts.push(encoder.encode(text));

	for (const [name, value] of Object.entries(opts.fields)) {
		push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
	}
	push(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${opts.filename}"\r\n` +
			`Content-Type: ${opts.mime}\r\n\r\n`,
	);
	parts.push(new Uint8Array(opts.file));
	push(`\r\n--${boundary}--\r\n`);

	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		body.set(part, offset);
		offset += part.length;
	}
	return { body, boundary, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * OpenAI 兼容的 /audio/transcriptions。
 * 手工拼 multipart，因为 Obsidian 的 requestUrl 收不到 FormData；
 * 走 requestUrl 而不是 fetch，是为了绕开手机端的 CORS 限制。
 */
export async function transcribeCloud(opts: CloudAsrOptions): Promise<string> {
	const base = opts.baseUrl.replace(/\/+$/, "");
	const fields: Record<string, string> = { model: opts.model, response_format: "json" };
	if (opts.language) fields.language = opts.language;

	const { body, contentType } = buildMultipart({
		fields,
		filename: opts.filename,
		mime: opts.mime,
		file: opts.audio,
	});

	const resp = await requestUrl({
		url: `${base}/audio/transcriptions`,
		method: "POST",
		contentType,
		headers: { Authorization: `Bearer ${opts.apiKey}` },
		body: body.buffer as ArrayBuffer,
		throw: false,
	});

	if (resp.status >= 400) {
		let detail = resp.text?.slice(0, 300) ?? "";
		try {
			const err = resp.json as { error?: { message?: string }; message?: string };
			detail = err?.error?.message || err?.message || detail;
		} catch {
			/* ignore */
		}
		throw new Error(`云端转写 ${resp.status}：${detail || "请求失败"}`);
	}

	const data = resp.json as { text?: string };
	if (typeof data?.text === "string") return data.text.trim();

	// 少数服务商返回纯文本
	const raw = resp.text?.trim() ?? "";
	if (raw && !raw.startsWith("{")) return raw;
	throw new Error("云端转写返回里没有 text 字段");
}
