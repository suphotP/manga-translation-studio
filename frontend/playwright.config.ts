import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const chromeCandidates = [
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
	join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1217", "chrome-win64", "chrome.exe"),
	join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1208", "chrome-win64", "chrome.exe"),
].filter(Boolean) as string[];

const chromiumExecutablePath = chromeCandidates.find((candidate) => existsSync(candidate));

export default defineConfig({
	testDir: "./e2e",
	timeout: 60_000,
	expect: {
		timeout: 10_000,
	},
	fullyParallel: true,
	reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
	use: {
		baseURL: "http://localhost:5173",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
		launchOptions: chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : undefined,
	},
	webServer: {
		command: "bun run dev -- --host 0.0.0.0",
		url: "http://localhost:5173",
		reuseExistingServer: true,
		timeout: 30_000,
		env: {
			VITE_E2E: "1",
		},
	},
	projects: [
		{
			name: "chromium-desktop",
			use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
		},
		{
			name: "chromium-tablet",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 820, height: 1180 },
				deviceScaleFactor: 2,
				hasTouch: true,
			},
		},
		{
			name: "chromium-mobile",
			use: { ...devices["Pixel 7"], viewport: { width: 412, height: 915 } },
		},
	],
});
