import type { RightPanelMode } from "$lib/stores/editor-ui.svelte.js";
import type { ToolId } from "./tool-registry.svelte.js";

export type EasyModeId = "clean" | "translate" | "typeset";

export interface ToolHelp {
	/** Short, user-facing label for shortcut/help surfaces. */
	shortcutLabel: string;
	/** Why this tool exists; shown in the cheat sheet when space allows. */
	shortcutDescription: string;
	/** Compact hint for Easy Mode tool chips. */
	easyModeHint?: string;
}

export interface EasyModeRecipe {
	id: EasyModeId;
	label: string;
	shortLabel: string;
	detail: string;
	primaryToolId: ToolId;
	toolIds: ToolId[];
	rightPanelMode: RightPanelMode;
	statusMessage: string;
}

export const TOOL_HELP: Partial<Record<ToolId, ToolHelp>> = {
	select: {
		shortcutLabel: "เลือก / ขยับ",
		shortcutDescription: "เลือกเลเยอร์ ย้ายกล่องข้อความ หรือกลับจากเครื่องมือเฉพาะทาง",
		easyModeHint: "กลับไปเลือกเลเยอร์",
	},
	crop: {
		shortcutLabel: "เลือกพื้นที่",
		shortcutDescription: "ตีกรอบพื้นที่สำหรับ AI หรือจัดสัดส่วนงานบนหน้า",
		easyModeHint: "ตีกรอบพื้นที่",
	},
	text: {
		shortcutLabel: "วางข้อความ",
		shortcutDescription: "สร้างกล่องข้อความที่แก้ไขและจัดวางได้",
		easyModeHint: "วางคำแปล",
	},
	marquee: {
		shortcutLabel: "เลือกสี่เหลี่ยม",
		shortcutDescription: "เลือกพื้นที่สี่เหลี่ยมในภาพเพื่อเตรียม clean หรือ refine",
		easyModeHint: "เลือกกรอบ",
	},
	lasso: {
		shortcutLabel: "เลือกอิสระ",
		shortcutDescription: "ลากเลือกพื้นที่รูปทรงอิสระในภาพ",
		easyModeHint: "ลากเลือก",
	},
	"magic-wand": {
		shortcutLabel: "ไม้กายสิทธิ์",
		shortcutDescription: "เลือกพื้นที่สีใกล้เคียงด้วยคลิกเดียว",
		easyModeHint: "เลือกสีใกล้เคียง",
	},
	"magic-clean": {
		shortcutLabel: "Magic Clean",
		shortcutDescription: "เลือกและคลีนบอลลูนแบบเร็วในคลิกเดียว",
		easyModeHint: "คลีนเร็ว",
	},
	"bucket-fill": {
		shortcutLabel: "ถังสี",
		shortcutDescription: "เติมสีหรือพื้นกระดาษในพื้นที่ที่เลือก",
		easyModeHint: "เติมพื้น",
	},
	"healing-brush": {
		shortcutLabel: "ซ่อมจุด",
		shortcutDescription: "แปรงซ่อมจุดหรือลบรอยเล็กบนภาพ",
		easyModeHint: "ซ่อมรอยเล็ก",
	},
	"pro-clean": {
		shortcutLabel: "คลีนโปร",
		shortcutDescription: "คลีนพื้น flat, gradient หรือ texture อัตโนมัติ",
		easyModeHint: "คลีนพื้นยาก",
	},
	"clone-stamp": {
		shortcutLabel: "โคลนพื้นที่",
		shortcutDescription: "คัดลอกพื้นผิวจากจุดต้นทางไปปิดงานแก้",
		easyModeHint: "ปั๊มพื้นผิว",
	},
	"bubble-clean": {
		shortcutLabel: "เคลียร์บอลลูน",
		shortcutDescription: "คลิกในบอลลูนเพื่อลบตัวอักษรและเติมพื้น ไม่ล้นขอบ",
		easyModeHint: "คลิกในบอลลูน",
	},
	"screentone-fill": {
		shortcutLabel: "สกรีนโทน",
		shortcutDescription: "เติมสกรีนโทนจากพื้นที่หรือ mask ที่เลือกไว้",
		easyModeHint: "เติมโทน",
	},
	cover: {
		shortcutLabel: "AI พื้นที่",
		shortcutDescription: "เลือกพื้นที่สำหรับ AI Clean หรือ SFX",
		easyModeHint: "ส่งพื้นที่ให้ AI",
	},
};

export const EASY_MODE_RECIPES: EasyModeRecipe[] = [
	{
		id: "clean",
		label: "คลีน",
		shortLabel: "Clean",
		detail: "ลบตัวอักษร/ซ่อมพื้นภาพ",
		primaryToolId: "bubble-clean",
		toolIds: ["bubble-clean", "healing-brush", "clone-stamp", "magic-wand"],
		rightPanelMode: "ai",
		statusMessage: "Easy Mode: คลีนหน้า - ใช้เคลียร์บอลลูนหรือแปรงซ่อมภาพ",
	},
	{
		id: "translate",
		label: "แปล",
		shortLabel: "แปล",
		detail: "เปิดงานคำแปลและวางข้อความ",
		primaryToolId: "translate",
		toolIds: ["translate", "text", "select"],
		rightPanelMode: "translate",
		statusMessage: "Easy Mode: แปล - เปิดงานคำแปลและเตรียมวางกล่องข้อความ",
	},
	{
		id: "typeset",
		label: "ไทป์",
		shortLabel: "Type",
		detail: "จัดกล่องข้อความบนหน้า",
		primaryToolId: "text",
		toolIds: ["text", "select", "crop"],
		rightPanelMode: "layers",
		statusMessage: "Easy Mode: ไทป์ - ใช้ Text/Layers เพื่อจัดคำบนหน้า",
	},
];

export function getToolHelp(toolId: ToolId): ToolHelp | undefined {
	return TOOL_HELP[toolId];
}

export function getEasyModeRecipe(id: EasyModeId): EasyModeRecipe | undefined {
	return EASY_MODE_RECIPES.find((recipe) => recipe.id === id);
}
