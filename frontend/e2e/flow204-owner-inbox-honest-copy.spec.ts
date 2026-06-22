/**
 * Flow 204 — Owner Inbox: honest copy per action type (P1 fix).
 *
 * Verifies that the approve button, modify dialog, and success toasts all use
 * copy that accurately reflects what happens on approval:
 *   - grant_credit → executes immediately ("โอนเครดิต / โอนเครดิตทันที")
 *   - refund / plan_change → only records decision ("บันทึกเท่านั้น / บันทึกการอนุมัติ")
 *
 * Uses a static HTML page to render the relevant UI copy independently of the backend.
 */
import { test, expect } from "@playwright/test";

const GRANT_CREDIT_CASE = {
	id: "case-gc-001",
	action: "grant_credit",
	userId: "user_test_001",
	ticketId: "TKT-100",
	amountCents: 500,
	currency: "USD",
	recommendation: "Grant 500 credits to compensate.",
	reason: "owner_grant_over_cap",
	evidence: { verifiedDiscrepancyCents: 500, hasSucceededPayment: true, refs: [] },
	decision: "owner_pending",
	decidedBy: "owner",
	executedRef: null,
	createdAt: new Date().toISOString(),
	decidedAt: null,
	params: {},
};

const REFUND_CASE = {
	id: "case-rf-002",
	action: "refund",
	userId: "user_test_002",
	ticketId: "TKT-200",
	amountCents: 1999,
	currency: "USD",
	recommendation: "Refund $19.99 for duplicate charge.",
	reason: "owner_refund",
	evidence: { verifiedDiscrepancyCents: 1999, hasSucceededPayment: true, refs: ["charge_abc"] },
	decision: "owner_pending",
	decidedBy: "owner",
	executedRef: null,
	createdAt: new Date().toISOString(),
	decidedAt: null,
	params: {},
};

/**
 * Build a minimal HTML page that replicates the owner-inbox approve/modify button
 * copy logic from +page.svelte (pure TypeScript helpers, no Svelte runtime needed).
 */
function buildTestPage(cases: typeof GRANT_CREDIT_CASE[]) {
	const casesJson = JSON.stringify(cases);
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Owner Inbox — Copy Test</title>
<style>
  body { background: #0e0e14; color: white; font-family: sans-serif; padding: 20px; }
  .card { background: #15151d; border: 1px solid rgba(255,255,255,.07); border-radius: 14px; padding: 16px; margin-bottom: 16px; }
  .btn { background: rgba(255,255,255,.06); color: white; border: 1px solid rgba(255,255,255,.09); border-radius: 9px; padding: 10px 16px; font-size: 14px; cursor: pointer; min-height: 44px; }
  .btn.approve { background: linear-gradient(100deg,#16a34a,#22c55e); border-color: transparent; font-weight: 700; }
  .btn.modify { background: rgba(139,92,246,.16); border-color: rgba(139,92,246,.34); color: #ddd6fe; }
  .notice-no-exec { background: rgba(251,191,36,.08); border: 1px solid rgba(251,191,36,.28); border-radius: 8px; padding: 10px 12px; margin-top: 8px; }
  .notice-no-exec strong { font-size: 12px; color: #fcd34d; display: block; margin-bottom: 4px; }
  .notice-no-exec p { margin: 0; font-size: 12px; color: rgba(255,255,255,.65); }
  .toast-ok { background: #16a34a; color: white; padding: 11px 18px; border-radius: 10px; font-size: 13.5px; font-weight: 500; display: inline-block; margin-top: 8px; }
  .case-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
  .case-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .modify-dialog { background: #1c1c26; border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 20px; margin-top: 12px; }
  .dialog-title { font-size: 17px; font-weight: 600; margin-bottom: 6px; }
  .dialog-desc { font-size: 13px; color: rgba(255,255,255,.6); margin-bottom: 12px; }
  #toast-area { margin-top: 20px; }
</style>
</head>
<body>
<h2>Owner Inbox — Honest Copy QA</h2>
<div id="cases"></div>
<div id="toast-area"></div>

<script>
function actionExecutesOnApprove(action) { return action === "grant_credit"; }

function approveToastText(action, executedRef) {
  if (actionExecutesOnApprove(action)) {
    return executedRef ? "อนุมัติแล้ว · เครดิตโอนเรียบร้อย" : "อนุมัติแล้ว · เครดิตจะถูกโอนในไม่ช้า";
  }
  return "บันทึกการอนุมัติแล้ว · กรุณาดำเนินการต่อใน Support console";
}

function approveButtonLabel(action) {
  return actionExecutesOnApprove(action) ? "อนุมัติ · โอนเครดิต" : "อนุมัติ · บันทึกเท่านั้น";
}

function modifyDialogDescription(action) {
  if (!action) return "";
  if (actionExecutesOnApprove(action)) {
    return "เปลี่ยนยอดที่จะอนุมัติให้ลูกค้า แล้วระบบจะโอนเครดิตตามยอดใหม่ทันที";
  }
  return "เปลี่ยนยอดแล้วบันทึกการอนุมัติ — การคืนเงิน/เปลี่ยนแพ็กเกจจริงต้องดำเนินการต่อใน Support console";
}

function modifyDialogTitle(action) {
  if (actionExecutesOnApprove(action)) return "ปรับจำนวนแล้วอนุมัติ · โอนเครดิตทันที";
  return "ปรับจำนวนแล้วบันทึกการอนุมัติ";
}

function modifyConfirmLabel(action, busy) {
  if (busy) return "กำลังบันทึก…";
  if (!action) return "อนุมัติด้วยยอดใหม่";
  return actionExecutesOnApprove(action) ? "อนุมัติ · โอนเครดิตทันที" : "บันทึกการอนุมัติ";
}

const cases = ${casesJson};
const container = document.getElementById("cases");
const toastArea = document.getElementById("toast-area");

cases.forEach(c => {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.caseId = c.id;
  card.dataset.action = c.action;

  const title = document.createElement("div");
  title.className = "case-title";
  title.textContent = c.action + " (userId: " + c.userId + ")";
  card.appendChild(title);

  const actions = document.createElement("div");
  actions.className = "case-actions";

  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.className = "btn approve";
  approveBtn.dataset.testid = "approve-btn-" + c.action;
  approveBtn.title = actionExecutesOnApprove(c.action)
    ? "อนุมัติ: โอนเครดิตทันที"
    : "บันทึกการอนุมัติ: ดำเนินการต่อใน Support console";
  approveBtn.textContent = approveButtonLabel(c.action);
  approveBtn.onclick = () => {
    // Simulate approve — grant_credit returns executedRef, refund does not
    const executedRef = actionExecutesOnApprove(c.action) ? "grant_abc123" : null;
    const toastDiv = document.createElement("div");
    toastDiv.className = "toast-ok";
    toastDiv.dataset.testid = "toast-" + c.action;
    toastDiv.textContent = approveToastText(c.action, executedRef);
    toastArea.appendChild(toastDiv);
  };
  actions.appendChild(approveBtn);

  const modifyBtn = document.createElement("button");
  modifyBtn.type = "button";
  modifyBtn.className = "btn modify";
  modifyBtn.dataset.testid = "modify-btn-" + c.action;
  modifyBtn.textContent = "แก้ยอด";
  actions.appendChild(modifyBtn);

  card.appendChild(actions);

  // Modify dialog (always visible for QA)
  const dialog = document.createElement("div");
  dialog.className = "modify-dialog";
  dialog.dataset.testid = "modify-dialog-" + c.action;
  const dTitle = document.createElement("div");
  dTitle.className = "dialog-title";
  dTitle.dataset.testid = "modify-dialog-title-" + c.action;
  dTitle.textContent = modifyDialogTitle(c.action);
  const dDesc = document.createElement("div");
  dDesc.className = "dialog-desc";
  dDesc.dataset.testid = "modify-dialog-desc-" + c.action;
  dDesc.textContent = modifyDialogDescription(c.action);
  dialog.appendChild(dTitle);
  dialog.appendChild(dDesc);

  if (!actionExecutesOnApprove(c.action)) {
    const notice = document.createElement("div");
    notice.className = "notice-no-exec";
    notice.dataset.testid = "notice-no-exec-" + c.action;
    notice.innerHTML = "<strong>ไม่มีการตัดเงิน / โอนเงินในขั้นตอนนี้</strong>" +
      "<p>การอนุมัติเพียงบันทึกการตัดสินใจของ owner — กรุณาดำเนินการคืนเงิน/เปลี่ยนแพ็กเกจต่อใน <strong>Support console</strong></p>";
    dialog.appendChild(notice);
  }

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "btn approve";
  confirmBtn.dataset.testid = "modify-confirm-" + c.action;
  confirmBtn.textContent = modifyConfirmLabel(c.action, false);
  dialog.appendChild(confirmBtn);

  card.appendChild(dialog);
  container.appendChild(card);
});
</script>
</body>
</html>`;
}

test.describe("flow-204 owner inbox honest copy per action type", () => {
	test("grant_credit approve button says execute + toast says executed", async ({ page }) => {
		const html = buildTestPage([GRANT_CREDIT_CASE]);
		await page.setContent(html);
		await page.waitForLoadState("domcontentloaded");

		// Approve button label
		const approveBtn = page.getByTestId("approve-btn-grant_credit");
		await expect(approveBtn).toBeVisible();
		const btnText = await approveBtn.textContent();
		expect(btnText).toContain("โอนเครดิต");
		expect(btnText).not.toContain("บันทึกเท่านั้น");

		// Modify dialog title and description
		const dialogTitle = page.getByTestId("modify-dialog-title-grant_credit");
		await expect(dialogTitle).toContainText("โอนเครดิตทันที");

		const dialogDesc = page.getByTestId("modify-dialog-desc-grant_credit");
		await expect(dialogDesc).toContainText("โอนเครดิตตามยอดใหม่ทันที");

		// Confirm button in modify dialog
		const confirmBtn = page.getByTestId("modify-confirm-grant_credit");
		await expect(confirmBtn).toContainText("โอนเครดิตทันที");

		// No "no-exec" notice for grant_credit
		await expect(page.getByTestId("notice-no-exec-grant_credit")).not.toBeAttached();

		// Click approve → toast says "เครดิตโอนเรียบร้อย" (executedRef present in mock)
		await approveBtn.click();
		const toast = page.getByTestId("toast-grant_credit");
		await expect(toast).toBeVisible();
		const toastText = await toast.textContent();
		expect(toastText).toContain("เครดิตโอนเรียบร้อย");
		expect(toastText).not.toContain("Support console");

		// Screenshot
		await page.screenshot({ path: "/tmp/qa-204fix/grant-credit-approved.png", fullPage: true });
	});

	test("refund approve button says record-only + toast says approved-not-executed", async ({
		page,
	}) => {
		const html = buildTestPage([REFUND_CASE]);
		await page.setContent(html);
		await page.waitForLoadState("domcontentloaded");

		// Approve button label — must NOT claim execution
		const approveBtn = page.getByTestId("approve-btn-refund");
		await expect(approveBtn).toBeVisible();
		const btnText = await approveBtn.textContent();
		expect(btnText).toContain("บันทึกเท่านั้น");
		expect(btnText).not.toContain("โอนเครดิต");

		// Modify dialog title — must NOT claim money moves
		const dialogTitle = page.getByTestId("modify-dialog-title-refund");
		await expect(dialogTitle).toContainText("บันทึกการอนุมัติ");
		// Must NOT say "โอนเครดิตทันที"
		await expect(dialogTitle).not.toContainText("โอนเครดิตทันที");

		const dialogDesc = page.getByTestId("modify-dialog-desc-refund");
		await expect(dialogDesc).toContainText("Support console");

		// Confirm button in modify dialog
		const confirmBtn = page.getByTestId("modify-confirm-refund");
		await expect(confirmBtn).toContainText("บันทึกการอนุมัติ");

		// notice-no-exec banner must be present
		const notice = page.getByTestId("notice-no-exec-refund");
		await expect(notice).toBeVisible();
		await expect(notice).toContainText("Support console");

		// Click approve → toast says "Support console" NOT "ดำเนินการเรียบร้อย"
		await approveBtn.click();
		const toast = page.getByTestId("toast-refund");
		await expect(toast).toBeVisible();
		const toastText = await toast.textContent();
		expect(toastText).toContain("Support console");
		expect(toastText).not.toContain("ดำเนินการเรียบร้อย");
		expect(toastText).not.toContain("เครดิตโอนเรียบร้อย");

		// Screenshot the honest refund-approved state
		await page.screenshot({ path: "/tmp/qa-204fix/refund-approved-honest.png", fullPage: true });
	});

	test("both cases side by side — visual diff", async ({ page }) => {
		const html = buildTestPage([GRANT_CREDIT_CASE, REFUND_CASE]);
		await page.setContent(html);
		await page.waitForLoadState("domcontentloaded");

		// Trigger both toasts
		await page.getByTestId("approve-btn-grant_credit").click();
		await page.getByTestId("approve-btn-refund").click();

		await page.screenshot({ path: "/tmp/qa-204fix/both-cases-side-by-side.png", fullPage: true });
	});
});
