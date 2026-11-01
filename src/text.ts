/** 去掉表情符号和 SenseVoice 之类的控制标记，只动这些，不改文字。 */
export function stripEmoji(input: string): string {
	if (!input) return "";
	return input
		.replace(/<\|[^|]*\|>/g, "")
		.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}]/gu, "")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** 文件名里不能出现的字符 */
export function sanitizeTitle(title: string): string {
	return title
		.replace(/[\\/:*?"<>|#^[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 40);
}
