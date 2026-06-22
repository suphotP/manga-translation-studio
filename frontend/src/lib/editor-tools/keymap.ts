export type KeymapPlatform = "mac" | "windows" | "linux" | "other";
export type KeymapContext = string;
export type KeymapWhen = KeymapContext | readonly KeymapContext[];

export interface KeymapAction {
	id: string;
	keys: readonly string[];
	when?: KeymapWhen;
	allowInInput?: boolean;
	allowRepeat?: boolean;
	label?: string;
	group?: string;
	order?: number;
}

export interface EditorCommandBinding {
	id: string;
	keys: readonly string[];
	when?: KeymapWhen;
	allowInInput?: boolean;
	allowRepeat?: boolean;
	label: string;
	group: "selection" | "paint" | "manga" | "history" | "color";
	order: number;
	dockToolId?: string;
	suiteToolId?: string;
	legacyIds?: readonly string[];
	compactHint?: string;
	visibleInShortcutSheet?: boolean;
}

export interface RegisteredKeymapAction {
	id: string;
	keys: string[];
	when?: string | string[];
	allowInInput: boolean;
	allowRepeat: boolean;
	label?: string;
	group?: string;
	order: number;
}

export interface KeymapOptions {
	platform?: KeymapPlatform;
}

export interface SerializedKeymapAction {
	id: string;
	keys: string[];
	when?: string | string[];
	allowInInput?: boolean;
	allowRepeat?: boolean;
	label?: string;
	group?: string;
	order?: number;
}

export interface SerializedKeymap {
	version: 1;
	actions: SerializedKeymapAction[];
}

export interface KeymapConflict {
	key: string;
	context?: string | string[];
	actionIds: [string, string];
}

export interface KeymapCheatSheetEntry {
	id: string;
	label: string;
	keys: string[];
	when?: string | string[];
}

export interface KeymapCheatSheetGroup {
	id: string;
	title: string;
	entries: KeymapCheatSheetEntry[];
}

interface StoredKeymapAction {
	id: string;
	keys: string[];
	when?: string[];
	contextSignature: string;
	allowInInput: boolean;
	allowRepeat: boolean;
	label?: string;
	group?: string;
	order: number;
	registrationIndex: number;
}

const KEYMAP_VERSION = 1;
const GLOBAL_CONTEXT_SIGNATURE = "*";
const MODIFIER_ORDER = ["shift", "mod", "ctrl", "alt", "meta"] as const;
const MODIFIER_ALIASES = new Set([
	"alt",
	"cmd",
	"command",
	"control",
	"ctrl",
	"meta",
	"mod",
	"option",
	"shift",
]);

const DEFAULT_GROUP_TITLES: Record<string, string> = {
	selection: "Selection",
	paint: "Paint / clean",
	manga: "Manga tools",
	history: "History",
	color: "Color",
	custom: "Custom",
};

export class KeymapConflictError extends Error {
	readonly conflicts: KeymapConflict[];

	constructor(conflicts: KeymapConflict[]) {
		super(`Keymap conflict: ${conflicts.map(formatConflict).join("; ")}`);
		this.name = "KeymapConflictError";
		this.conflicts = conflicts;
	}
}

export class Keymap {
	private readonly platform: KeymapPlatform;
	private readonly actions = new Map<string, StoredKeymapAction>();
	private registrationCounter = 0;

	constructor(actions: readonly KeymapAction[] = [], options: KeymapOptions = {}) {
		this.platform = options.platform ?? detectKeymapPlatform();
		for (const action of actions) {
			this.register(action);
		}
	}

	register(action: KeymapAction): () => boolean {
		if (this.actions.has(action.id)) {
			throw new Error(`Keymap action "${action.id}" is already registered`);
		}

		const normalized = this.normalizeAction(action, this.registrationCounter);
		const conflicts = this.findConflictsForStoredAction(normalized);
		if (conflicts.length > 0) {
			throw new KeymapConflictError(conflicts);
		}

		this.actions.set(normalized.id, normalized);
		this.registrationCounter += 1;
		return () => this.unregister(normalized.id);
	}

	unregister(id: string): boolean {
		return this.actions.delete(id);
	}

	resolve(event: KeyboardEvent, activeContexts: Iterable<string> = []): string | null {
		if (event.type !== "keydown") {
			return null;
		}

		const chord = eventChord(event, this.platform);
		if (!chord) {
			return null;
		}

		const activeContextSet = new Set(activeContexts);
		const editableTarget = isEditableEventTarget(event.target);
		const matches = [...this.actions.values()]
			.filter((action) => action.keys.includes(chord))
			.filter((action) => matchesContext(action.when, activeContextSet))
			.filter((action) => !event.repeat || action.allowRepeat)
			.filter((action) => !editableTarget || action.allowInInput)
			.sort((a, b) => {
				const contextWeight = (b.when?.length ?? 0) - (a.when?.length ?? 0);
				if (contextWeight !== 0) {
					return contextWeight;
				}
				return a.registrationIndex - b.registrationIndex;
			});

		return matches[0]?.id ?? null;
	}

	getAction(id: string): RegisteredKeymapAction | undefined {
		const action = this.actions.get(id);
		return action ? toRegisteredAction(action) : undefined;
	}

	listActions(): RegisteredKeymapAction[] {
		return [...this.actions.values()]
			.sort((a, b) => a.registrationIndex - b.registrationIndex)
			.map(toRegisteredAction);
	}

	findConflicts(action?: KeymapAction): KeymapConflict[] {
		if (action) {
			return this.findConflictsForStoredAction(this.normalizeAction(action, this.registrationCounter));
		}

		const conflicts: KeymapConflict[] = [];
		const actions = [...this.actions.values()];
		for (let i = 0; i < actions.length; i += 1) {
			for (let j = i + 1; j < actions.length; j += 1) {
				conflicts.push(...findStoredActionConflicts(actions[i], actions[j]));
			}
		}
		return conflicts;
	}

	serialize(): SerializedKeymap {
		return {
			version: KEYMAP_VERSION,
			actions: [...this.actions.values()]
				.sort((a, b) => a.registrationIndex - b.registrationIndex)
				.map((action) => {
					const serialized: SerializedKeymapAction = {
						id: action.id,
						keys: [...action.keys],
					};
					const when = publicWhen(action.when);
					if (when) {
						serialized.when = when;
					}
					if (action.allowInInput) {
						serialized.allowInInput = true;
					}
					if (action.allowRepeat) {
						serialized.allowRepeat = true;
					}
					if (action.label) {
						serialized.label = action.label;
					}
					if (action.group) {
						serialized.group = action.group;
					}
					if (action.order !== 0) {
						serialized.order = action.order;
					}
					return serialized;
				}),
		};
	}

	cheatSheet(): KeymapCheatSheetGroup[] {
		const groups = new Map<string, KeymapCheatSheetGroup>();
		const sortedActions = [...this.actions.values()].sort((a, b) => {
			const groupCompare = (a.group ?? "custom").localeCompare(b.group ?? "custom");
			if (groupCompare !== 0) {
				return groupCompare;
			}
			const orderCompare = a.order - b.order;
			if (orderCompare !== 0) {
				return orderCompare;
			}
			return a.registrationIndex - b.registrationIndex;
		});

		for (const action of sortedActions) {
			const groupId = action.group ?? "custom";
			const group =
				groups.get(groupId) ??
				{
					id: groupId,
					title: DEFAULT_GROUP_TITLES[groupId] ?? titleFromId(groupId),
					entries: [],
				};
			group.entries.push({
				id: action.id,
				label: action.label ?? titleFromId(action.id),
				keys: [...action.keys],
				when: publicWhen(action.when),
			});
			groups.set(groupId, group);
		}

		return [...groups.values()];
	}

	static deserialize(serialized: SerializedKeymap, options: KeymapOptions = {}): Keymap {
		return deserializeKeymap(serialized, options);
	}

	private normalizeAction(action: KeymapAction, registrationIndex: number): StoredKeymapAction {
		const id = normalizeId(action.id, "action id");
		const keys = normalizeKeys(action.keys, this.platform);
		const when = normalizeWhen(action.when);
		return {
			id,
			keys,
			when,
			contextSignature: contextSignature(when),
			allowInInput: action.allowInInput ?? false,
			allowRepeat: action.allowRepeat ?? false,
			label: action.label,
			group: action.group,
			order: action.order ?? 0,
			registrationIndex,
		};
	}

	private findConflictsForStoredAction(action: StoredKeymapAction): KeymapConflict[] {
		return [...this.actions.values()].flatMap((existing) =>
			findStoredActionConflicts(action, existing),
		);
	}
}

export const DEFAULT_EDITOR_COMMAND_BINDINGS = [
	{
		id: "editor.tool.select",
		keys: ["v"],
		when: "editor",
		label: "Select / move",
		group: "selection",
		order: 10,
		dockToolId: "select",
		legacyIds: ["editor.tool.move"],
	},
	{
		id: "editor.tool.marquee",
		keys: ["m"],
		when: "editor",
		label: "Rectangular marquee",
		group: "selection",
		order: 20,
		dockToolId: "marquee",
		suiteToolId: "marquee",
	},
	{
		id: "editor.tool.lasso",
		keys: ["l"],
		when: "editor",
		label: "Freehand lasso",
		group: "selection",
		order: 30,
		dockToolId: "lasso",
		suiteToolId: "lasso",
	},
	{
		id: "editor.tool.polygon-lasso",
		keys: ["shift+l"],
		when: "editor",
		label: "Polygon lasso",
		group: "selection",
		order: 35,
		dockToolId: "polygon-lasso",
		suiteToolId: "polygon-lasso",
	},
	{
		id: "editor.tool.magic-wand",
		keys: ["w"],
		when: "editor",
		label: "Magic wand",
		group: "selection",
		order: 40,
		dockToolId: "magic-wand",
		suiteToolId: "magic-wand",
	},
	{
		id: "editor.tool.color-range",
		keys: ["shift+w"],
		when: "editor",
		label: "Color range",
		group: "selection",
		order: 45,
		dockToolId: "color-range",
		suiteToolId: "color-range",
	},
	{
		id: "editor.tool.region-frame",
		keys: ["c"],
		when: "editor",
		label: "Region frame",
		group: "selection",
		order: 50,
		dockToolId: "crop",
		legacyIds: ["editor.tool.crop"],
	},
	{
		id: "editor.tool.pro-clean",
		keys: ["shift+b"],
		when: "editor",
		label: "Pro Clean brush",
		group: "paint",
		order: 70,
		dockToolId: "pro-clean",
		suiteToolId: "pro-clean",
	},
	{
		id: "editor.tool.healing-brush",
		keys: ["j"],
		when: "editor",
		label: "Spot healing brush",
		group: "paint",
		order: 80,
		dockToolId: "healing-brush",
		suiteToolId: "healing-brush",
		legacyIds: ["editor.tool.healing"],
	},
	{
		id: "editor.tool.clone-stamp",
		keys: ["s"],
		when: "editor",
		label: "Clone stamp",
		group: "paint",
		order: 90,
		dockToolId: "clone-stamp",
		suiteToolId: "clone-stamp",
	},
	{
		id: "editor.tool.bucket-fill",
		keys: ["g"],
		when: "editor",
		label: "Bucket fill",
		group: "paint",
		order: 100,
		dockToolId: "bucket-fill",
		suiteToolId: "bucket-fill",
		legacyIds: ["editor.tool.fill"],
	},
	{
		id: "editor.tool.text",
		keys: ["t"],
		when: "editor",
		label: "Text",
		group: "paint",
		order: 110,
		dockToolId: "text",
	},
	{
		id: "editor.tool.ai-region",
		keys: ["a"],
		when: "editor",
		label: "AI region",
		group: "manga",
		order: 10,
		dockToolId: "cover",
	},
	{
		id: "editor.tool.screentone-fill",
		keys: ["shift+g"],
		when: "editor",
		label: "Screentone fill",
		group: "manga",
		order: 20,
		dockToolId: "screentone-fill",
		suiteToolId: "screentone-fill",
	},
	{
		id: "editor.tool.bubble-clean",
		keys: ["k"],
		when: "editor",
		label: "Bubble auto-clean",
		group: "manga",
		order: 30,
		dockToolId: "bubble-clean",
		suiteToolId: "bubble-clean",
	},
	{
		id: "editor.tool.magic-clean",
		keys: ["shift+k"],
		when: "editor",
		label: "Magic clean",
		group: "manga",
		order: 40,
		dockToolId: "magic-clean",
		suiteToolId: "magic-clean",
	},
	{
		id: "editor.tool.refine-edge",
		keys: ["shift+r"],
		when: "editor",
		label: "Refine edge",
		group: "selection",
		order: 60,
		dockToolId: "refine-edge",
		suiteToolId: "refine-edge",
	},
	{
		id: "editor.undo",
		keys: ["mod+z"],
		when: "editor",
		label: "Undo",
		group: "history",
		order: 10,
	},
	{
		id: "editor.redo",
		keys: ["shift+mod+z"],
		when: "editor",
		label: "Redo",
		group: "history",
		order: 20,
	},
	{
		id: "editor.brush.size.decrease",
		keys: ["["],
		when: "editor",
		allowRepeat: true,
		label: "Decrease brush size",
		group: "paint",
		order: 10,
	},
	{
		id: "editor.brush.size.increase",
		keys: ["]"],
		when: "editor",
		allowRepeat: true,
		label: "Increase brush size",
		group: "paint",
		order: 20,
	},
	{
		id: "editor.colors.swap",
		keys: ["x"],
		when: "editor",
		label: "Swap colors",
		group: "color",
		order: 10,
	},
] as const satisfies readonly EditorCommandBinding[] as readonly EditorCommandBinding[];
// widened back to the interface type: the exact-tuple inference from `as const`
// makes optional fields (legacyIds/dockToolId/suiteToolId) TS2339 under strict
// checks at the iteration sites (codex P2)

export const DEFAULT_EDITOR_KEYMAP_ACTIONS: readonly KeymapAction[] =
	DEFAULT_EDITOR_COMMAND_BINDINGS.map(toKeymapAction);

const DEFAULT_EDITOR_COMMAND_BY_ID = new Map<string, EditorCommandBinding>();
for (const binding of DEFAULT_EDITOR_COMMAND_BINDINGS) {
	DEFAULT_EDITOR_COMMAND_BY_ID.set(binding.id, binding);
	for (const legacyId of binding.legacyIds ?? []) {
		DEFAULT_EDITOR_COMMAND_BY_ID.set(legacyId, binding);
	}
}

function toKeymapAction(binding: EditorCommandBinding): KeymapAction {
	return {
		id: binding.id,
		keys: binding.keys,
		when: binding.when,
		allowInInput: binding.allowInInput,
		allowRepeat: binding.allowRepeat,
		label: binding.label,
		group: binding.group,
		order: binding.order,
	};
}

export function canonicalEditorActionId(actionId: string): string {
	return DEFAULT_EDITOR_COMMAND_BY_ID.get(actionId)?.id ?? actionId;
}

export function getDefaultEditorCommandBinding(actionId: string): EditorCommandBinding | undefined {
	return DEFAULT_EDITOR_COMMAND_BY_ID.get(actionId);
}

export function getEditorShortcutForDockTool(toolId: string): string | undefined {
	const binding = DEFAULT_EDITOR_COMMAND_BINDINGS.find((command) => command.dockToolId === toolId);
	return binding ? editorShortcutHint(binding) : undefined;
}

export function getEditorShortcutForSuiteTool(toolId: string): string | undefined {
	const binding = DEFAULT_EDITOR_COMMAND_BINDINGS.find((command) => command.suiteToolId === toolId);
	return binding ? editorShortcutHint(binding) : undefined;
}

export function editorShortcutHint(binding: EditorCommandBinding): string {
	return binding.compactHint ?? formatShortcutHint(binding.keys[0]);
}

export function formatShortcutHint(chord: string): string {
	return chord
		.split("+")
		.map((part) => {
			switch (part) {
				case "shift":
					return "Shift";
				case "mod":
					return "Mod";
				case "ctrl":
					return "Ctrl";
				case "alt":
					return "Alt";
				case "meta":
					return "Meta";
				case "escape":
					return "Esc";
				case "space":
					return "Space";
				default:
					return part.length === 1 && /[a-z]/.test(part) ? part.toUpperCase() : part;
			}
		})
		.join("+");
}

export function createDefaultEditorKeymap(options: KeymapOptions = {}): Keymap {
	return new Keymap(DEFAULT_EDITOR_KEYMAP_ACTIONS, options);
}

export function deserializeKeymap(serialized: SerializedKeymap, options: KeymapOptions = {}): Keymap {
	if (serialized.version !== KEYMAP_VERSION) {
		throw new Error(`Unsupported keymap version: ${serialized.version}`);
	}
	return new Keymap(serialized.actions, options);
}

export function normalizeKeyBinding(binding: string, platform: KeymapPlatform = detectKeymapPlatform()): string {
	return parseKeyBinding(binding, platform);
}

export function detectKeymapPlatform(): KeymapPlatform {
	if (typeof navigator !== "undefined") {
		const platform = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
		if (/mac|iphone|ipad|ipod/i.test(platform)) {
			return "mac";
		}
		if (/win/i.test(platform)) {
			return "windows";
		}
		if (/linux|x11/i.test(platform)) {
			return "linux";
		}
	}
	return "other";
}

function findStoredActionConflicts(
	action: StoredKeymapAction,
	existing: StoredKeymapAction,
): KeymapConflict[] {
	if (action.id === existing.id || action.contextSignature !== existing.contextSignature) {
		return [];
	}

	return action.keys
		.filter((key) => existing.keys.includes(key))
		.map((key) => ({
			key,
			context: publicWhen(action.when),
			actionIds: [existing.id, action.id],
		}));
}

function normalizeKeys(keys: readonly string[], platform: KeymapPlatform): string[] {
	if (keys.length === 0) {
		throw new Error("Keymap actions need at least one key");
	}

	const normalized = keys.map((key) => parseKeyBinding(key, platform));
	const unique = new Set(normalized);
	if (unique.size !== normalized.length) {
		throw new Error(`Duplicate key binding in action: ${normalized.join(", ")}`);
	}
	return normalized;
}

function parseKeyBinding(binding: string, platform: KeymapPlatform): string {
	const rawParts = binding
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	if (rawParts.length === 0) {
		throw new Error("Key binding cannot be empty");
	}

	const modifiers = new Set<string>();
	let key: string | null = null;
	for (const part of rawParts) {
		const normalized = normalizeKeyName(part);
		if (MODIFIER_ALIASES.has(normalized)) {
			modifiers.add(normalizeModifier(normalized, platform));
			continue;
		}
		if (key) {
			throw new Error(`Key binding "${binding}" has more than one non-modifier key`);
		}
		key = normalized;
	}

	if (!key || MODIFIER_ALIASES.has(key)) {
		throw new Error(`Key binding "${binding}" must include a non-modifier key`);
	}

	return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

function eventChord(event: KeyboardEvent, platform: KeymapPlatform): string | null {
	const key = eventKeyName(event);
	if (!key || MODIFIER_ALIASES.has(key)) {
		return null;
	}

	const modifiers = new Set<string>();
	if (event.shiftKey) {
		modifiers.add("shift");
	}
	if (event.altKey) {
		modifiers.add("alt");
	}
	if (isMacPlatform(platform)) {
		if (event.metaKey) {
			modifiers.add("mod");
		}
		if (event.ctrlKey) {
			modifiers.add("ctrl");
		}
	} else {
		if (event.ctrlKey) {
			modifiers.add("mod");
		}
		if (event.metaKey) {
			modifiers.add("meta");
		}
	}

	return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

function eventKeyName(event: KeyboardEvent): string {
	// Tool accelerators should follow physical muscle memory even when the active
	// keyboard layout is Thai/IME. Punctuation still uses event.key because its
	// physical position varies more across layouts.
	const physicalLetter = physicalLatinLetter(event.code);
	if (physicalLetter) {
		return physicalLetter;
	}
	return normalizeKeyName(event.key);
}

function physicalLatinLetter(code: string | undefined): string | null {
	if (!code || !/^Key[A-Z]$/.test(code)) {
		return null;
	}
	return code.slice(3).toLowerCase();
}

function normalizeModifier(modifier: string, platform: KeymapPlatform): string {
	switch (modifier) {
		case "cmd":
		case "command":
		case "meta":
			return isMacPlatform(platform) ? "mod" : "meta";
		case "control":
		case "ctrl":
			return isMacPlatform(platform) ? "ctrl" : "mod";
		case "option":
			return "alt";
		default:
			return modifier;
	}
}

function normalizeKeyName(key: string): string {
	const trimmed = key.trim();
	if (trimmed === "") {
		return key === " " ? "space" : "";
	}

	const lowered = trimmed.toLowerCase();
	switch (lowered) {
		case " ":
		case "spacebar":
			return "space";
		case "esc":
			return "escape";
		case "arrowup":
			return "up";
		case "arrowdown":
			return "down";
		case "arrowleft":
			return "left";
		case "arrowright":
			return "right";
		default:
			return lowered;
	}
}

function normalizeWhen(when: KeymapWhen | undefined): string[] | undefined {
	if (!when) {
		return undefined;
	}
	const contexts = (Array.isArray(when) ? when : [when]).map((context) =>
		normalizeId(context, "context"),
	);
	const unique = [...new Set(contexts)].sort();
	return unique.length > 0 ? unique : undefined;
}

function normalizeId(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error(`Keymap ${label} cannot be empty`);
	}
	return normalized;
}

function matchesContext(required: readonly string[] | undefined, activeContexts: Set<string>): boolean {
	if (!required) {
		return true;
	}
	return required.every((context) => activeContexts.has(context));
}

function contextSignature(contexts: readonly string[] | undefined): string {
	return contexts?.join("&") ?? GLOBAL_CONTEXT_SIGNATURE;
}

function publicWhen(contexts: readonly string[] | undefined): string | string[] | undefined {
	if (!contexts) {
		return undefined;
	}
	return contexts.length === 1 ? contexts[0] : [...contexts];
}

function toRegisteredAction(action: StoredKeymapAction): RegisteredKeymapAction {
	const registered: RegisteredKeymapAction = {
		id: action.id,
		keys: [...action.keys],
		allowInInput: action.allowInInput,
		allowRepeat: action.allowRepeat,
		order: action.order,
	};
	const when = publicWhen(action.when);
	if (when) {
		registered.when = when;
	}
	if (action.label) {
		registered.label = action.label;
	}
	if (action.group) {
		registered.group = action.group;
	}
	return registered;
}

function isEditableEventTarget(target: EventTarget | null): boolean {
	// Key handlers live high in the editor tree; walk up so nested spans inside a
	// contenteditable text field do not accidentally trigger destructive tools.
	if (!target || typeof Element === "undefined" || !(target instanceof Element)) {
		return false;
	}

	let element: Element | null = target;
	while (element) {
		const tagName = element.tagName.toLowerCase();
		if (tagName === "input" || tagName === "textarea" || tagName === "select") {
			return true;
		}
		if (element.getAttribute("role") === "textbox") {
			return true;
		}
		const contentEditable = element.getAttribute("contenteditable");
		if (contentEditable !== null && contentEditable.toLowerCase() !== "false") {
			return true;
		}
		if (element instanceof HTMLElement && element.isContentEditable) {
			return true;
		}
		element = element.parentElement;
	}
	return false;
}

function isMacPlatform(platform: KeymapPlatform): boolean {
	return platform === "mac";
}

function titleFromId(id: string): string {
	return id
		.split(/[.\-_]/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function formatConflict(conflict: KeymapConflict): string {
	const context = Array.isArray(conflict.context)
		? conflict.context.join("&")
		: (conflict.context ?? "global");
	return `${conflict.key} in ${context} (${conflict.actionIds.join(" vs ")})`;
}
