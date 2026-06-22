// Notification title/body localisation.
//
// Notifications are produced server-side with a baked `title`/`body` string (the
// producer's wording, historically Thai/English). For notifications that the
// backend tags with i18n keys in `metadata` (`titleKey`/`titleParams` and
// optionally `bodyKey`/`bodyParams`), the VIEWER's locale should win so a Thai
// user never reads an English payload (and vice-versa). When no key is present we
// fall back to the baked string so legacy + untagged notifications still render.
//
// `format` is the svelte-i18n formatter ($_ / $format): it returns the key
// itself on a miss, so we guard against that and fall back to the baked text.

interface NotificationLike {
	title: string;
	body?: string;
	metadata?: Record<string, unknown> | null;
}

// svelte-i18n's $_/$format value type (a subset of InterpolationValues that we
// actually pass) — keeps the helper assignable from the store's MessageFormatter.
type MsgValues = Record<string, string | number | boolean | Date | null | undefined>;
type FormatFn = (key: string, options?: { values?: MsgValues }) => string;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

// Subject-kind codes the work-state notifications carry as a `kind` param. They
// must themselves be localised (otherwise "You were assigned page work" leaks the
// raw English code into other locales), so we resolve them through the dedicated
// `notifications.message.kind.<code>` keys before interpolating the message.
const SUBJECT_KIND_CODES = new Set(["page", "chapter", "project"]);

function asParams(value: unknown, format: FormatFn): MsgValues | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	// Server params are JSON scalars (string/number/bool); coerce to the message
	// value type and drop anything non-scalar so the formatter stays happy.
	const params: MsgValues = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v instanceof Date) {
			params[k] = v as MsgValues[string];
		}
	}
	const kind = params.kind;
	if (typeof kind === "string" && SUBJECT_KIND_CODES.has(kind)) {
		const key = `notifications.message.kind.${kind}`;
		const resolved = format(key);
		params.kind = resolved && resolved !== key ? resolved : kind;
	}
	return params;
}

function resolve(format: FormatFn, key: string | undefined, params: MsgValues | undefined, fallback: string): string {
	if (!key) return fallback;
	const out = format(key, params ? { values: params } : undefined);
	// svelte-i18n returns the key unchanged on a miss / before init.
	return out && out !== key ? out : fallback;
}

/** Localised notification title — `metadata.titleKey` wins, else baked `title`. */
export function localizedNotificationTitle(entry: NotificationLike, format: FormatFn): string {
	const meta = entry.metadata ?? undefined;
	return resolve(format, asString(meta?.titleKey), asParams(meta?.titleParams, format), entry.title);
}

/** Localised notification body — `metadata.bodyKey` wins, else baked `body`. */
export function localizedNotificationBody(entry: NotificationLike, format: FormatFn): string {
	const meta = entry.metadata ?? undefined;
	return resolve(format, asString(meta?.bodyKey), asParams(meta?.bodyParams, format), entry.body ?? "");
}
