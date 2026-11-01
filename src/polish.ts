import { requestUrl } from "obsidian";

export interface PolishResult {
	title: string;
	summary: string;
	body: string;
	todos: string[];
}

export interface PolishOptions {
	apiKey: string;
	baseUrl: string;
	model: string;
	transcript: string;
}

const SYSTEM_PROMPT = [
	"你是笔记整理助手。把用户给的语音转写整理成结构化笔记。",
	"硬性要求：",
	"1. 只整理，不新增事实；转写里没有的信息一律不要写。",
	"2. 去掉口水词和重复，保留原意，不要扩写成散文。",
	"3. 待办只提取「明确要做的事」；没有就返回空数组，不要凑数。",
	"4. 只输出 JSON，不要 Markdown 代码块，不要解释。",
	'输出结构：{"title": "不超过20字", "summary": "一句话提要", "body": "整理后的正文，分点或短段落，400字以内", "todos": ["待办1", "待办2"]}',
].join("\n");

export async function polishTranscript(opts: PolishOptions): Promise<PolishResult> {
	const base = opts.baseUrl.replace(/\/+$/, "");
	const resp = await requestUrl({
		url: `${base}/chat/completions`,
		method: "POST",
		contentType: "application/json",
		headers: {
			Authorization: `Bearer ${opts.apiKey}`,
		},
		body: JSON.stringify({
			model: opts.model,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: opts.transcript },
			],
			temperature: 0.3,
			max_tokens: 1200,
			response_format: { type: "json_object" },
		}),
		throw: false,
	});

	if (resp.status >= 400) {
		let detail = resp.text?.slice(0, 300) ?? "";
		try {
			const err = resp.json as { error?: { message?: string } };
			if (err?.error?.message) detail = err.error.message;
		} catch {
			/* ignore */
		}
		throw new Error(`DeepSeek ${resp.status}：${detail || "请求失败"}`);
	}

	const data = resp.json as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const content = data?.choices?.[0]?.message?.content ?? "";
	const parsed = parseJson(content);
	if (!parsed) throw new Error("模型没有返回合法 JSON");

	const todosRaw = Array.isArray(parsed.todos) ? (parsed.todos as unknown[]) : [];
	const todos = todosRaw
		.map((t) => (typeof t === "string" ? t : ""))
		.map((t) => t.trim())
		.filter((t) => t.length > 0);

	return {
		title: typeof parsed.title === "string" ? parsed.title.trim() : "",
		summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
		body: typeof parsed.body === "string" ? parsed.body.trim() : "",
		todos,
	};
}

function parseJson(raw: string): Record<string, unknown> | null {
	const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	try {
		const value = JSON.parse(text);
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
	} catch {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
			} catch {
				return null;
			}
		}
		return null;
	}
}
