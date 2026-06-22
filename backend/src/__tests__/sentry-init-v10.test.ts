import { describe, expect, mock, test } from "bun:test";

const initMock = mock((_options: Record<string, unknown>) => undefined);
const captureExceptionMock = mock((_error: unknown) => "event-id");
const setHttpStatusMock = mock((_span: unknown, _status: number) => undefined);

const integrationFactory = (name: string) => mock((_options?: Record<string, unknown>) => ({ name }));

const onUncaughtExceptionIntegrationMock = integrationFactory("OnUncaughtException");
const onUnhandledRejectionIntegrationMock = integrationFactory("OnUnhandledRejection");
const captureConsoleIntegrationMock = integrationFactory("CaptureConsole");
const httpIntegrationMock = integrationFactory("Http");
const linkedErrorsIntegrationMock = integrationFactory("LinkedErrors");
const requestDataIntegrationMock = integrationFactory("RequestData");
const nodeContextIntegrationMock = integrationFactory("NodeContext");

const scope = {
	setTag: mock((_key: string, _value: string) => undefined),
	setContext: mock((_key: string, _value: Record<string, unknown>) => undefined),
	setExtra: mock((_key: string, _value: unknown) => undefined),
	setExtras: mock((_extras: Record<string, unknown>) => undefined),
};

const span = {};
const startSpanMock = mock(async (_options: Record<string, unknown>, callback: (activeSpan: unknown) => Promise<unknown>) => {
	return callback(span);
});
const withScopeMock = mock((callback: (activeScope: typeof scope) => unknown) => callback(scope));

mock.module("@sentry/bun", () => ({
	init: initMock,
	captureException: captureExceptionMock,
	captureMessage: mock((_message: string, _context?: unknown) => "event-id"),
	onUncaughtExceptionIntegration: onUncaughtExceptionIntegrationMock,
	onUnhandledRejectionIntegration: onUnhandledRejectionIntegrationMock,
	captureConsoleIntegration: captureConsoleIntegrationMock,
	httpIntegration: httpIntegrationMock,
	linkedErrorsIntegration: linkedErrorsIntegrationMock,
	requestDataIntegration: requestDataIntegrationMock,
	nodeContextIntegration: nodeContextIntegrationMock,
	startSpan: startSpanMock,
	setHttpStatus: setHttpStatusMock,
	withScope: withScopeMock,
}));

const { initSentry, sentryMiddleware } = await import("../middleware/sentry.js");

describe("Sentry v10 initialization", () => {
	test("returns silently without a DSN and does not initialize Sentry", () => {
		const originalDsn = process.env.SENTRY_DSN;
		delete process.env.SENTRY_DSN;

		try {
			initSentry();
			expect(initMock).not.toHaveBeenCalled();
		} finally {
			if (originalDsn === undefined) {
				delete process.env.SENTRY_DSN;
			} else {
				process.env.SENTRY_DSN = originalDsn;
			}
		}
	});

	test("initializes Sentry with v10 factory integrations and sampling config", () => {
		initSentry({
			dsn: "https://public@example.ingest.sentry.io/123",
			environment: "test",
			tracesSampleRate: 0.25,
			profilesSampleRate: 0.5,
		});

		expect(initMock).toHaveBeenCalledTimes(1);
		const options = initMock.mock.calls[0]![0] as Record<string, any>;
		expect(options.dsn).toBe("https://public@example.ingest.sentry.io/123");
		expect(options.environment).toBe("test");
		expect(options.tracesSampleRate).toBe(0.25);
		expect(options.profilesSampleRate).toBe(0.5);
		expect(options.release).toBeString();
		expect(options.beforeSend).toBeFunction();
		expect(options.integrations.map((integration: { name: string }) => integration.name)).toEqual([
			"OnUncaughtException",
			"OnUnhandledRejection",
			"CaptureConsole",
			"Http",
			"LinkedErrors",
			"RequestData",
			"NodeContext",
		]);
		expect(onUncaughtExceptionIntegrationMock).toHaveBeenCalledWith({
			exitEvenIfOtherHandlersAreRegistered: false,
		});
		expect(onUnhandledRejectionIntegrationMock).toHaveBeenCalledWith({
			mode: "warn",
		});
		expect(captureConsoleIntegrationMock).toHaveBeenCalledWith({
			levels: ["error", "warn"],
		});
	});

	test("captures middleware errors inside a v10 active span and scoped request context", async () => {
		captureExceptionMock.mockClear();
		setHttpStatusMock.mockClear();

		const error = new Error("request failed");
		const middleware = sentryMiddleware();
		const context = {
			req: {
				method: "POST",
				routePath: "/api/projects/:id",
				path: "/api/projects/abc",
				url: "http://localhost/api/projects/abc?debug=true",
				header: () => ({ authorization: "secret", "x-request-id": "req-1" }),
				query: () => ({ debug: "true" }),
				raw: { body: "request-body" },
			},
			res: { status: 500 },
		};

		await expect(middleware(context as any, async () => {
			throw error;
		})).rejects.toThrow("request failed");

		expect(startSpanMock).toHaveBeenCalledWith(expect.objectContaining({
			op: "http.server",
			name: "POST /api/projects/:id",
			forceTransaction: true,
		}), expect.any(Function));
		expect(withScopeMock).toHaveBeenCalled();
		expect(setHttpStatusMock).toHaveBeenCalledWith(span, 500);
		expect(scope.setExtras).toHaveBeenCalledWith({
			request_body: "request-body",
			query_params: { debug: "true" },
		});
		expect(captureExceptionMock).toHaveBeenCalledWith(error);
	});
});
