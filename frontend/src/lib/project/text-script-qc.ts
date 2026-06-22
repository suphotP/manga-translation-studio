export type TextScriptGroup = "latin" | "thai" | "kana" | "cjk" | "hangul" | "other";

export interface TextScriptMismatch {
	mismatch: boolean;
	targetScripts: TextScriptGroup[];
	dominantScript: TextScriptGroup | null;
	dominantRatio: number;
	totalLetters: number;
	nonTargetLetters: number;
}

const TARGET_SCRIPT_GROUPS: Record<string, TextScriptGroup[]> = {
	de: ["latin"],
	en: ["latin"],
	es: ["latin"],
	fr: ["latin"],
	ja: ["kana", "cjk"],
	ko: ["hangul", "cjk"],
	pt: ["latin"],
	th: ["thai"],
	zh: ["cjk"],
};

function getTargetScripts(targetLang: string): TextScriptGroup[] {
	return TARGET_SCRIPT_GROUPS[targetLang.toLowerCase()] ?? [];
}

function getScriptGroup(char: string): TextScriptGroup | null {
	if (/[A-Za-z\u00c0-\u024f]/u.test(char)) return "latin";
	if (/[\u0e00-\u0e7f]/u.test(char)) return "thai";
	if (/[\u3040-\u30ff]/u.test(char)) return "kana";
	if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(char)) return "cjk";
	if (/[\uac00-\ud7af]/u.test(char)) return "hangul";
	if (/\p{L}/u.test(char)) return "other";
	return null;
}

export function detectTextScriptMismatch(text: string, targetLang: string): TextScriptMismatch {
	const targetScripts = getTargetScripts(targetLang);
	const counts = new Map<TextScriptGroup, number>();

	for (const char of Array.from(text)) {
		const group = getScriptGroup(char);
		if (!group) continue;
		counts.set(group, (counts.get(group) ?? 0) + 1);
	}

	const totalLetters = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
	const dominant = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
	const dominantScript = dominant?.[0] ?? null;
	const dominantRatio = dominant && totalLetters > 0 ? dominant[1] / totalLetters : 0;

	if (targetScripts.length === 0 || totalLetters < 5) {
		return {
			mismatch: false,
			targetScripts,
			dominantScript,
			dominantRatio,
			totalLetters,
			nonTargetLetters: 0,
		};
	}

	const nonTargetLetters = Array.from(counts.entries())
		.filter(([group]) => group !== "other" && !targetScripts.includes(group))
		.reduce((sum, [, count]) => sum + count, 0);
	const nonTargetRatio = totalLetters > 0 ? nonTargetLetters / totalLetters : 0;

	return {
		mismatch: nonTargetLetters >= 5 && nonTargetRatio >= 0.7,
		targetScripts,
		dominantScript,
		dominantRatio,
		totalLetters,
		nonTargetLetters,
	};
}
