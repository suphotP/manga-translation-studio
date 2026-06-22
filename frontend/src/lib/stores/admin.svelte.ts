// Admin store — config management
// Svelte 5 class-based store

import * as api from "$lib/api/client.ts";
import { authStore } from "$lib/stores/auth.svelte.ts";
import type { AdminConfig } from "$lib/types.js";

class AdminStore {
	showDialog = $state(false);
	isSaving = $state(false);
	saveMessage = $state("");
	saveError = $state(false);
	config = $state<AdminConfig>({
		openrouterEnabled: false,
		openrouterApiKey: "",
		chatgptEnabled: true,
		primaryBackend: "chatgpt",
	});

	updateField<K extends keyof AdminConfig>(key: K, value: AdminConfig[K]): void {
		this.config[key] = value;
	}

	async open(): Promise<void> {
		this.showDialog = true;
		this.saveMessage = "";
		this.saveError = false;
		if (!authStore.can("manage:settings")) {
			this.saveError = true;
			this.saveMessage = "เข้าใช้งานด้วยสิทธิ์ Admin ก่อนแก้การตั้งค่า";
			return;
		}
		try {
			this.config = await api.getAdminConfig();
		} catch {
			// Use defaults if backend unreachable
		}
	}

	async save(): Promise<void> {
		if (!authStore.can("manage:settings")) {
			this.saveError = true;
			this.saveMessage = "เข้าใช้งานด้วยสิทธิ์ Admin ก่อนแก้การตั้งค่า";
			return;
		}
		this.isSaving = true;
		this.saveMessage = "";
		this.saveError = false;

		try {
			await api.updateAdminConfig({
				openrouterEnabled: this.config.openrouterEnabled,
				openrouterApiKey: this.config.openrouterApiKey,
				chatgptEnabled: this.config.chatgptEnabled,
				primaryBackend: this.config.primaryBackend,
			});
			this.saveMessage = "บันทึกการตั้งค่าแล้ว";
			setTimeout(() => {
				this.showDialog = false;
				this.saveMessage = "";
			}, 1000);
		} catch (e: any) {
			this.saveError = true;
			this.saveMessage = `บันทึกการตั้งค่าไม่สำเร็จ: ${e?.message || "ลองใหม่อีกครั้ง"}`;
		} finally {
			this.isSaving = false;
		}
	}

	close(): void {
		this.showDialog = false;
	}
}

export const adminStore = new AdminStore();
