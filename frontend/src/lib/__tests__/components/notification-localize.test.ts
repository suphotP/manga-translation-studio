import { describe, it, expect } from "vitest";

import en from "$lib/i18n/locales/en.json";
import th from "$lib/i18n/locales/th.json";
import {
	localizedNotificationTitle,
	localizedNotificationBody,
} from "$lib/components/notification-localize.ts";

type Dict = Record<string, unknown>;

// A tiny stand-in for svelte-i18n's $_ that resolves a dotted key against a
// bundled locale dict and interpolates {tokens} from `values` — mirroring the
// real formatter closely enough to assert the localisation path end-to-end. On a
// miss it returns the key unchanged (exactly what svelte-i18n does), which is the
// behaviour our helper relies on to fall back to the baked string.
function makeFormat(dict: Dict) {
	return (key: string, options?: { values?: Record<string, unknown> }) => {
		const leaf = key.split(".").reduce<unknown>((node, part) => {
			if (node && typeof node === "object") return (node as Dict)[part];
			return undefined;
		}, dict);
		if (typeof leaf !== "string") return key;
		const values = options?.values ?? {};
		return leaf.replace(/\{(\w+)\}/g, (_m, name) => (name in values ? String(values[name]) : `{${name}}`));
	};
}

const enFormat = makeFormat(en as Dict);
const thFormat = makeFormat(th as Dict);

const workAssigned = {
	title: "You were assigned page work",
	body: '"Page 12" is now in_progress and assigned to you.',
	metadata: {
		titleKey: "notifications.message.workAssignedTitle",
		titleParams: { kind: "page" },
		bodyKey: "notifications.message.workAssignedBody",
		bodyParams: { subject: "Page 12", state: "in_progress" },
	},
};

describe("notification localisation", () => {
	it("renders the viewer-locale title from metadata.titleKey (kind code localised too)", () => {
		// EN: subject-kind code "page" resolves to the EN word "page".
		expect(localizedNotificationTitle(workAssigned, enFormat)).toBe("You were assigned page work");
		// TH: the SAME notification renders fully in Thai, kind code included — no
		// English leaks (the bug this fixes).
		expect(localizedNotificationTitle(workAssigned, thFormat)).toBe("คุณได้รับมอบหมายงานหน้า");
	});

	it("renders the viewer-locale body from metadata.bodyKey", () => {
		expect(localizedNotificationBody(workAssigned, enFormat)).toBe('"Page 12" is now in_progress and assigned to you.');
		expect(localizedNotificationBody(workAssigned, thFormat)).toBe('"Page 12" อยู่ในสถานะ in_progress และมอบหมายให้คุณแล้ว');
	});

	it("falls back to the baked title/body when no metadata key is present", () => {
		const legacy = { title: "Legacy baked title", body: "Legacy baked body", metadata: {} };
		expect(localizedNotificationTitle(legacy, thFormat)).toBe("Legacy baked title");
		expect(localizedNotificationBody(legacy, thFormat)).toBe("Legacy baked body");
	});

	it("falls back to the baked string when the key is missing from the dict", () => {
		const broken = { title: "Baked", body: "Body", metadata: { titleKey: "notifications.message.doesNotExist" } };
		expect(localizedNotificationTitle(broken, enFormat)).toBe("Baked");
	});
});
