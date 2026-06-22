import { describe, expect, it } from "vitest";
import {
	batchExportActionTargetLabel,
	exportCreditPolicyStatusMessage,
	exportCreditSummaryPolicyLabel,
	exportPolicyControlLabel,
	exportProfileForCreditPolicy,
	exportRunTargetProfileLabel,
	exportRetryActionLabel,
	normalizeExportProfileId,
	requiredCreditGateDetail,
	requiredCreditMissingHoldReason,
	requiredCreditMissingMessage,
	workboardCreditPolicyDetail,
} from "$lib/project/export-profiles.js";
import type { ExportRun } from "$lib/types.js";

function exportRun(overrides: Partial<ExportRun> = {}): ExportRun {
	return {
		id: "export-1",
		kind: "batch-zip",
		status: "error",
		filename: "chapter.zip",
		pageIndexes: [0, 1],
		pageCount: 2,
		message: "Export failed",
		createdAt: "2026-05-22T00:00:00.000Z",
		completedAt: "2026-05-22T00:00:00.000Z",
		...overrides,
	};
}

describe("export profile copy", () => {
	it("maps credit policy to explicit export profiles", () => {
		expect(exportProfileForCreditPolicy("optional").shortLabel).toBe("ร่าง/ภายใน");
		expect(exportProfileForCreditPolicy(undefined).shortLabel).toBe("ร่าง/ภายใน");
		expect(exportProfileForCreditPolicy("required").shortLabel).toBe("เผยแพร่/ส่งออก");
		expect(normalizeExportProfileId("public-export")).toBe("public-export");
		expect(normalizeExportProfileId("bad-profile")).toBeUndefined();
		expect(exportPolicyControlLabel("optional")).toBe("ร่าง/ภายใน ไม่บังคับ");
		expect(exportPolicyControlLabel("required")).toBe("เผยแพร่/ส่งออก ต้องมี");
	});

	it("keeps required-credit blocker copy centralized", () => {
		expect(requiredCreditMissingHoldReason()).toBe("required credit missing");
		expect(requiredCreditMissingMessage()).toBe("ส่งออกยังไม่พร้อม: เผยแพร่/ส่งออก ต้องมีเครดิตอย่างน้อย 1 รายการในตอนนี้");
		expect(requiredCreditGateDetail()).toContain("ร่าง/ภายใน ยังตรวจหน้าได้ต่อ");
		expect(requiredCreditGateDetail()).toContain("เผยแพร่/ส่งออก ต้องมีเครดิต");
	});

	it("formats policy status and workboard credit detail from the same profile names", () => {
		expect(exportCreditPolicyStatusMessage("required")).toBe("ตั้งเครดิตเป็นเงื่อนไขสำหรับ เผยแพร่/ส่งออก แล้ว");
		expect(exportCreditPolicyStatusMessage("optional")).toBe("ตั้งเครดิตเป็น ร่าง/ภายใน ไม่บล็อกการส่งกลับแล้ว");
		expect(exportCreditSummaryPolicyLabel("required")).toBe("ส่งออกต้องมีเครดิต");
		expect(exportCreditSummaryPolicyLabel("optional")).toBe("ร่าง/ภายใน ไม่บังคับ");
		expect(workboardCreditPolicyDetail("required", 0)).toBe(
			"เป้าส่งออก เผยแพร่/ส่งออก: ต้องเพิ่มเครดิตอย่างน้อย 1 รายการก่อนส่งกลับโปรเจกต์หลัก",
		);
		expect(workboardCreditPolicyDetail("optional", 0)).toBe(
			"เป้าส่งออก ร่าง/ภายใน: ไม่มีเครดิตก็ไม่บล็อกส่งกลับ แต่ QC ยังเปิดเครื่องมือเครดิตได้",
		);
	});

	it("labels batch actions and retry artifacts without component-local string copies", () => {
		expect(batchExportActionTargetLabel("required")).toBe("เผยแพร่/ส่งออก");
		expect(batchExportActionTargetLabel("optional")).toBe("ส่งออก ZIP");
		expect(exportRunTargetProfileLabel(exportRun({ targetProfile: "public-export" }))).toBe("เผยแพร่/ส่งออก");
		expect(exportRunTargetProfileLabel(exportRun())).toBe("");
		expect(exportRetryActionLabel(exportRun())).toBe("ทำ ZIP ใหม่");
		expect(exportRetryActionLabel(exportRun({ kind: "single-page" }))).toBe("ทำ PNG ใหม่");
	});
});
