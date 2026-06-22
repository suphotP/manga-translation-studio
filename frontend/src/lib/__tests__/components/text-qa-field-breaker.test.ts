// TextQaField circuit-breaker (P1): the typo checker auto-fires on every
// keystroke. When the AI provider is down it returns 502
// `text_qa_provider_error` (retryable). Without a breaker the client keeps
// hammering `POST /api/text-qa/check` on each character → repeated 502s spammed
// to the console on a CORE action (typing). These tests pin the breaker: after
// N consecutive provider failures the client STOPS auto-firing checks (no more
// requests / 502s) until the user explicitly retries, and it resumes normally
// once the provider is healthy again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

// Hoisted mock for the API client. `checkTextQa` is the only call the field
// makes; `ApiError` must be the real shape (status + code) so the breaker's
// `isProviderFailure` classification works. Both are created via `vi.hoisted`
// so the (hoisted) `vi.mock` factory can reference them safely.
const { checkTextQa, ApiError } = vi.hoisted(() => {
	class ApiError extends Error {
		status: number;
		statusText: string;
		code?: string;
		constructor(message: string, details: { status: number; statusText?: string; code?: string }) {
			super(message);
			this.name = "ApiError";
			this.status = details.status;
			this.statusText = details.statusText ?? "";
			this.code = details.code;
		}
	}
	return { checkTextQa: vi.fn(), ApiError };
});

vi.mock("$lib/api/client.js", () => ({
	checkTextQa,
	ApiError,
}));

import "$lib/i18n";
import TextQaField from "$lib/components/TextQaField.svelte";
import { __resetTextQaBreakerForTesting } from "$lib/components/TextQaField.svelte";

function providerError(): InstanceType<typeof ApiError> {
	return new ApiError("provider down", {
		status: 502,
		statusText: "Bad Gateway",
		code: "text_qa_provider_error",
	});
}

// The field's `value` is parent-owned (controlled). Real usage: `onInput`
// commits the new text to the parent, which re-renders `value`. We mirror that
// here — set the prop via `rerender` AND fire the input event — so the
// component's `value`-guarded `scheduleCheck`/`runCheck` see the new text.
type Rerender = (props: Record<string, unknown>) => Promise<void> | void;

function makeTyper(
	textarea: HTMLTextAreaElement,
	rerender: Rerender,
	baseProps: Record<string, unknown>,
) {
	return async function typeAndFlush(next: string): Promise<void> {
		await rerender({ ...baseProps, value: next });
		await fireEvent.input(textarea, { target: { value: next } });
		await vi.runOnlyPendingTimersAsync();
		// Drain the resolved/rejected check promise + any follow-up microtasks.
		await Promise.resolve();
		await Promise.resolve();
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	checkTextQa.mockReset();
	__resetTextQaBreakerForTesting();
});

afterEach(() => {
	vi.useRealTimers();
	__resetTextQaBreakerForTesting();
});

describe("TextQaField provider circuit-breaker", () => {
	it("stops auto-firing checks after 3 consecutive provider failures", async () => {
		checkTextQa.mockRejectedValue(providerError());

		const baseProps = { lang: "th", onInput: vi.fn(), debounceMs: 10 };
		const { rerender } = render(TextQaField, { props: { ...baseProps, value: "" } });
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		const type = makeTyper(textarea, rerender, baseProps);

		// Three keystrokes → three checks → three provider failures → breaker trips.
		await type("aa");
		await type("aaa");
		await type("aaaa");
		expect(checkTextQa).toHaveBeenCalledTimes(3);

		// Subsequent keystrokes must NOT fire any more requests — the breaker is
		// open, so no fresh 502 hits the network/console.
		await type("aaaaa");
		await type("aaaaaa");
		await type("aaaaaaa");
		expect(checkTextQa).toHaveBeenCalledTimes(3);

		// A quiet, tappable "unavailable" retry hint is shown instead of an error.
		expect(screen.getByText(/ไม่พร้อมใช้งานชั่วคราว/)).toBeTruthy();
	});

	it("does NOT trip on quota (402) or disabled (503) — those are deterministic", async () => {
		checkTextQa.mockRejectedValue(
			new ApiError("quota", { status: 402, code: "text_qa_quota_exceeded" }),
		);

		const baseProps = { lang: "th", onInput: vi.fn(), debounceMs: 10 };
		const { rerender } = render(TextQaField, { props: { ...baseProps, value: "" } });
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		const type = makeTyper(textarea, rerender, baseProps);

		// Many quota failures must NOT open the breaker (it keeps surfacing the
		// real quota state, not a generic "unavailable").
		await type("aa");
		await type("aaa");
		await type("aaaa");
		await type("aaaaa");
		expect(checkTextQa).toHaveBeenCalledTimes(4);
		expect(screen.queryByText(/ไม่พร้อมใช้งานชั่วคราว/)).toBeNull();
	});

	it("an explicit retry tap re-fires once and resumes normally when the provider recovers", async () => {
		checkTextQa.mockRejectedValue(providerError());

		const baseProps = { lang: "th", onInput: vi.fn(), debounceMs: 10 };
		const { rerender } = render(TextQaField, { props: { ...baseProps, value: "" } });
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		const type = makeTyper(textarea, rerender, baseProps);

		await type("aa");
		await type("aaa");
		await type("aaaa");
		expect(checkTextQa).toHaveBeenCalledTimes(3);

		// Provider recovers; the user taps the retry hint.
		checkTextQa.mockReset();
		checkTextQa.mockResolvedValue({
			issues: [],
			cached: false,
			model: "gpt-4o-mini",
			lang: "th",
			quota: { usedChars: 4, limitChars: 50000, remainingChars: 49996, resetAt: Date.now() + 1000, planId: "free" },
		});

		const retry = screen.getByRole("button", { name: /ไม่พร้อมใช้งานชั่วคราว/ });
		await fireEvent.click(retry);
		await vi.runOnlyPendingTimersAsync();
		await Promise.resolve();
		await Promise.resolve();
		expect(checkTextQa).toHaveBeenCalledTimes(1);

		// Breaker reset by the successful probe → normal typing fires checks again.
		await type("aaaaa");
		expect(checkTextQa).toHaveBeenCalledTimes(2);
		expect(screen.queryByText(/ไม่พร้อมใช้งานชั่วคราว/)).toBeNull();
	});
});
