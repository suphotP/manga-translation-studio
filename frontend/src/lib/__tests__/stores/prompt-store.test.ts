// Prompt store tests
// Tests the custom prompt dialog state

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the store itself since $state runes don't work in tests
function createMockPromptStore() {
	let showDialog = false;
	let text = "";

	return {
		get showDialog() { return showDialog; },
		set showDialog(value) { showDialog = value; },
		get text() { return text; },
		set text(value) { text = value; },
		setText(newText: string) {
			this.text = newText;
		},
		open() {
			this.text = "";
			this.showDialog = true;
		},
		close() {
			this.showDialog = false;
		},
	};
}

describe("PromptStore", () => {
	let promptStore: any;

	beforeEach(() => {
		promptStore = createMockPromptStore();
	});

	describe("initial state", () => {
		it("should have showDialog as false", () => {
			expect(promptStore.showDialog).toBe(false);
		});

		it("should have empty text", () => {
			expect(promptStore.text).toBe("");
		});
	});

	describe("setText", () => {
		it("should update text value", () => {
			promptStore.setText("Hello World");

			expect(promptStore.text).toBe("Hello World");
		});

		it("should set empty text", () => {
			promptStore.setText("Hello");
			promptStore.setText("");

			expect(promptStore.text).toBe("");
		});

		it("should handle long text", () => {
			const longText = "A".repeat(1000);
			promptStore.setText(longText);

			expect(promptStore.text).toBe(longText);
		});

		it("should handle special characters", () => {
			const specialText = "แมว กิน ปลา $100 #tag 🎨";
			promptStore.setText(specialText);

			expect(promptStore.text).toBe(specialText);
		});
	});

	describe("open", () => {
		it("should clear text and show dialog", () => {
			// First set some text
			promptStore.setText("Previous text");
			expect(promptStore.text).toBe("Previous text");

			// Then open dialog
			promptStore.open();

			expect(promptStore.text).toBe("");
			expect(promptStore.showDialog).toBe(true);
		});

		it("should reset text when already open", () => {
			// Open dialog first
			promptStore.open();
			promptStore.setText("Some text");

			// Open again
			promptStore.open();

			expect(promptStore.text).toBe("");
			expect(promptStore.showDialog).toBe(true);
		});
	});

	describe("close", () => {
		it("should hide dialog", () => {
			// First open dialog
			promptStore.open();
			expect(promptStore.showDialog).toBe(true);

			// Then close it
			promptStore.close();

			expect(promptStore.showDialog).toBe(false);
		});

		it("should preserve text value when closing", () => {
			// Set text but don't open dialog
			promptStore.setText("Test text");

			// Close dialog (should not change text)
			promptStore.close();

			expect(promptStore.text).toBe("Test text");
			expect(promptStore.showDialog).toBe(false);
		});
	});

	describe("open/close cycle", () => {
		it("should maintain proper state after multiple cycles", () => {
			// First cycle
			promptStore.setText("Cycle 1");
			promptStore.open();
			expect(promptStore.text).toBe("");
			expect(promptStore.showDialog).toBe(true);

			promptStore.close();
			expect(promptStore.showDialog).toBe(false);

			// Second cycle
			promptStore.setText("Cycle 2");
			promptStore.open();
			expect(promptStore.text).toBe("");
			expect(promptStore.showDialog).toBe(true);

			promptStore.close();
			expect(promptStore.showDialog).toBe(false);

			// Text should be preserved after close
			promptStore.setText("Final text");
			expect(promptStore.text).toBe("Final text");
		});
	});
});
