// API client tests
// Tests the API client request building and error handling
// Mocks global fetch to avoid network calls

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock fetch before importing the client
const originalFetch = globalThis.fetch;

describe("API client", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    // Replace fetch with mock
    globalThis.fetch = mockFetch;
    mockFetch.mockClear();

    // Default mock response
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  afterEach(async () => {
    const { clearApiAccessToken } = await import("../api/client.js");
    clearApiAccessToken();
    // Restore fetch
    globalThis.fetch = originalFetch;
  });

  describe("auth session", () => {
    it("sends login credentials to the auth endpoint", async () => {
      const { login } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          user: {
            id: "user-1",
            email: "lead@example.com",
            name: "Lead",
            role: "editor",
            isActive: true,
          },
          tokens: {
            accessToken: "access-token",
            refreshToken: "refresh-token",
          },
        }), { status: 200 })
      );

      const result = await login("lead@example.com", "StrongP@ss123");

      expect(result.user.role).toBe("editor");
      expect(result.tokens.accessToken).toBe("access-token");
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/auth/login");
      expect(call[1]?.method).toBe("POST");
      expect(call[1]?.headers?.["Content-Type"]).toBe("application/json");
      expect(JSON.parse(call[1]?.body)).toEqual({
        email: "lead@example.com",
        password: "StrongP@ss123",
      });
    });

    it("attaches the access token to API requests without overriding explicit authorization", async () => {
      const { createProject, setApiAccessToken } = await import("../api/client.js");

      setApiAccessToken("access-token");
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ projectId: "proj-auth" }), { status: 200 })
      );

      await createProject("Auth Project", "en");

      const headers = mockFetch.mock.calls[0][1]?.headers as Headers;
      expect(headers).toBeInstanceOf(Headers);
      expect(headers.get("Authorization")).toBe("Bearer access-token");
      expect(headers.get("Content-Type")).toBe("application/json");
    });

    it("refreshes auth sessions through refresh token rotation endpoint", async () => {
      const { refreshAuthSession } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          user: { id: "user-1", email: "lead@example.com", name: "Lead", role: "editor", isActive: true },
          tokens: { accessToken: "access-2", refreshToken: "refresh-2" },
        }), { status: 200 })
      );

      const result = await refreshAuthSession("refresh-1");

      expect(result.tokens.refreshToken).toBe("refresh-2");
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/auth/refresh");
      expect(JSON.parse(call[1]?.body)).toEqual({ refreshToken: "refresh-1" });
    });
  });

  describe("createProject", () => {
    it("sends correct request", async () => {
      const { createProject } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ projectId: "test-123" }), { status: 200 })
      );

      const result = await createProject("Test", "th");
      expect(result.projectId).toBe("test-123");

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/project/new");
      expect(call[1]?.method).toBe("POST");
      expect(call[1]?.headers?.["Content-Type"]).toBe("application/json");

      const body = JSON.parse(call[1]?.body);
      expect(body.name).toBe("Test");
      expect(body.lang).toBe("th");
    });

    it("sends durable story and chapter metadata when provided", async () => {
      const { createProject } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ projectId: "test-123" }), { status: 200 })
      );

      await createProject("Moonlit Courier - ตอน 104", "th", {
        storyId: "moonlit-courier",
        storyTitle: "Moonlit Courier",
        chapterNumber: "104",
        chapterTitle: "Real File Smoke",
        chapterLabel: "ตอน 104 - Real File Smoke",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1]?.body);
      expect(body).toMatchObject({
        name: "Moonlit Courier - ตอน 104",
        lang: "th",
        storyId: "moonlit-courier",
        storyTitle: "Moonlit Courier",
        chapterNumber: "104",
        chapterTitle: "Real File Smoke",
        chapterLabel: "ตอน 104 - Real File Smoke",
      });
    });

    it("uses default language if not provided", async () => {
      const { createProject } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ projectId: "test-123" }), { status: 200 })
      );

      await createProject("Test");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.lang).toBe("th");
    });

    it("forwards workspaceId so the project is stamped to the workspace (dashboard P1)", async () => {
      const { createProject } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ projectId: "test-123" }), { status: 200 })
      );

      await createProject("WS Project", "th", { workspaceId: "ws-abc-123" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.workspaceId).toBe("ws-abc-123");
    });
  });

  describe("renameProjectStory", () => {
    it("PATCHes the story title", async () => {
      const { renameProjectStory } = await import("../api/client.js");
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ projectId: "p-1", storyId: "s-1", storyTitle: "New" }), { status: 200 }),
      );
      const result = await renameProjectStory("p-1", "New");
      expect(result.storyTitle).toBe("New");
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/project/p-1/story");
      expect(call[1]?.method).toBe("PATCH");
      expect(JSON.parse(call[1]?.body).storyTitle).toBe("New");
    });
  });

  describe("deleteProject", () => {
    it("DELETEs with a server-side confirmStoryTitle body", async () => {
      const { deleteProject } = await import("../api/client.js");
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, deleted: true, projectId: "p-1" }), { status: 200 }),
      );
      const result = await deleteProject("p-1", "Alpha Story");
      expect(result.deleted).toBe(true);
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/project/p-1");
      expect(call[1]?.method).toBe("DELETE");
      // The exact typed title is echoed to the server so it can re-enforce the
      // destructive confirmation (not just the UI dialog).
      expect(JSON.parse(call[1]?.body)).toEqual({ confirmStoryTitle: "Alpha Story" });
    });

    it("surfaces a 400 confirmation mismatch as a typed ApiError", async () => {
      const { deleteProject, ApiError } = await import("../api/client.js");
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Confirmation title does not match", code: "delete_confirmation_mismatch" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await expect(deleteProject("p-1", "Wrong")).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe("saveProject", () => {
    it("sends POST with project state", async () => {
      const { saveProject } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response("", { status: 200 })
      );

      const state = {
        projectId: "abc",
        name: "Test",
        createdAt: new Date().toISOString(),
        pages: [],
        currentPage: 0,
        targetLang: "th",
      };

      await saveProject("abc", state as any);

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/project/abc/save");
      expect(call[1]?.method).toBe("POST");
    });

    it("strips server-authoritative sub-collections from the save body (belt-and-suspenders)", async () => {
      const { saveProject } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

      // A hydrated in-memory project carries collections owned by dedicated
      // endpoints. The general save must NOT send its (possibly stale) copies, so
      // a stale client save can never overwrite a concurrent dedicated-endpoint
      // change even if the backend guard regressed.
      const state = {
        projectId: "abc",
        name: "Test",
        createdAt: new Date().toISOString(),
        pages: [{ imageId: "img-1" }],
        currentPage: 0,
        targetLang: "th",
        tasks: [{ id: "page-0-translate" }],
        activityLog: [{ id: "a1" }],
        comments: [{ id: "c1" }],
        aiReviewMarkers: [{ id: "m1" }],
        reviewDecisions: [{ id: "d1" }],
        reviewAssignments: [{ id: "ra1" }],
        revisionRequests: [{ id: "rr1" }],
        workspaceMessages: [{ id: "w1" }],
        versionReviewRequests: [{ id: "v1" }],
        exportRuns: [{ id: "e1" }],
        chapterTeam: [{ id: "ct1" }],
      };

      await saveProject("abc", state as any);

      const call = mockFetch.mock.calls[0];
      const sentBody = JSON.parse((call[1]?.body as string) ?? "{}");
      // Page/layer content is still sent...
      expect(sentBody.pages).toEqual([{ imageId: "img-1" }]);
      expect(sentBody.targetLang).toBe("th");
      // ...but every server-authoritative sub-collection is omitted. This list must
      // mirror the backend `/save` force-overrides (`body.x = state.x`); a missing
      // key (previously reviewAssignments/revisionRequests/chapterTeam) let a stale
      // tab's array reach the writer, defeating the belt-and-suspenders guard.
      for (const key of [
        "tasks",
        "activityLog",
        "comments",
        "aiReviewMarkers",
        "reviewDecisions",
        "reviewAssignments",
        "revisionRequests",
        "workspaceMessages",
        "versionReviewRequests",
        "exportRuns",
        "chapterTeam",
      ]) {
        expect(key in sentBody).toBe(false);
      }
      // The caller's project object is not mutated by the strip.
      expect(state.comments).toEqual([{ id: "c1" }]);
      expect(state.reviewAssignments).toEqual([{ id: "ra1" }]);
      expect(state.chapterTeam).toEqual([{ id: "ct1" }]);
    });

    it("P0-2: sends X-Edit-Page-Scoped + lease headers for a page-scoped leased save", async () => {
      const { saveProject } = await import("../api/client.js");
      mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
      const state = { projectId: "abc", name: "T", createdAt: new Date().toISOString(), pages: [], currentPage: 0, targetLang: "th" };
      await saveProject("abc", state as any, { editLockId: "lock-1", editClientId: "tab-a", pageScoped: true });
      const headers = new Headers(mockFetch.mock.calls[0][1]?.headers as HeadersInit);
      expect(headers.get("X-Edit-Lock-Id")).toBe("lock-1");
      expect(headers.get("X-Edit-Client-Id")).toBe("tab-a");
      expect(headers.get("X-Edit-Page-Scoped")).toBe("1");
    });

    it("P0-2: a displaced page-scoped save (page-scoped marker set, NO lock id) still flags page-scoped so the backend can require the header", async () => {
      const { saveProject } = await import("../api/client.js");
      mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
      const state = { projectId: "abc", name: "T", createdAt: new Date().toISOString(), pages: [], currentPage: 0, targetLang: "th" };
      // heldLockId is null when the lease was taken over, but the page-edit session
      // marker stays true — so the save is still flagged page-scoped and the backend's
      // require-lease-header gate can reject it (no dodging by omitting the lock id).
      await saveProject("abc", state as any, { editLockId: null, pageScoped: true });
      const headers = new Headers(mockFetch.mock.calls[0][1]?.headers as HeadersInit);
      expect(headers.get("X-Edit-Lock-Id")).toBeNull();
      expect(headers.get("X-Edit-Page-Scoped")).toBe("1");
    });

    it("a non-page-scoped (metadata) save sends no page-scoped marker", async () => {
      const { saveProject } = await import("../api/client.js");
      mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
      const state = { projectId: "abc", name: "T", createdAt: new Date().toISOString(), pages: [], currentPage: 0, targetLang: "th" };
      await saveProject("abc", state as any);
      const headers = new Headers(mockFetch.mock.calls[0][1]?.headers as HeadersInit);
      expect(headers.get("X-Edit-Page-Scoped")).toBeNull();
    });

    it("P0-2 (round-3): a baseFingerprint is sent as X-Project-Base-Fingerprint so cover/export full-payload saves go through CAS", async () => {
      // setProjectCover() and persistExportRunAfterConflict() now pass a baseFingerprint
      // captured from the state they loaded, so their full-payload (pages-bearing) saves
      // can no longer silently clobber newer page edits — a stale base is CAS-rejected.
      const { saveProject } = await import("../api/client.js");
      mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
      const state = { projectId: "abc", name: "T", createdAt: new Date().toISOString(), pages: [], currentPage: 0, targetLang: "th" };
      await saveProject("abc", state as any, { baseFingerprint: "deadbeef" });
      const headers = new Headers(mockFetch.mock.calls[0][1]?.headers as HeadersInit);
      expect(headers.get("X-Project-Base-Fingerprint")).toBe("deadbeef");
    });
  });

  describe("export artifacts", () => {
    it("uploads a batch export artifact as form data", async () => {
      const { uploadExportArtifact } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          artifact: {
            exportId: "export-1.zip",
            storageDriver: "local",
            storageKey: "projects/project-1/exports/export-1.zip",
            filename: "chapter.zip",
            mimeType: "application/zip",
            sizeBytes: 7,
            createdAt: "2026-05-17T00:00:00.000Z",
          },
          storageQuota: {
            projectId: "project-1",
            workspaceId: "project-1",
            enforced: true,
            usedBytes: 7,
            originalBytes: 0,
            derivativeBytes: 0,
            exportArtifactBytes: 7,
            pendingBytes: 0,
            includedBytes: 1073741824,
            extraBytes: 0,
            limitBytes: 1073741824,
            remainingBytes: 1073741817,
            percentUsed: 0,
            assetCount: 0,
            derivativeCount: 0,
            exportArtifactCount: 1,
          },
        }), { status: 200 })
      );

      const result = await uploadExportArtifact("project-1", "export-1", "chapter.zip", new Blob(["zipdata"], { type: "application/zip" }));

      expect(result.storageQuota?.exportArtifactBytes).toBe(7);
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/project/project-1/exports/export-1/artifact");
      expect(call[1]?.method).toBe("POST");
      expect(call[1]?.body).toBeInstanceOf(FormData);
    });

    it("downloads a persisted export artifact and parses the filename", async () => {
      const { downloadExportArtifact } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response("zipdata", {
          status: 200,
          headers: {
            "Content-Disposition": "attachment; filename=\"chapter.zip\"",
            "Content-Type": "application/zip",
          },
        })
      );

      const result = await downloadExportArtifact("project-1", "export-1");

      expect(result.filename).toBe("chapter.zip");
      expect(await result.blob.text()).toBe("zipdata");
      expect(mockFetch.mock.calls[0][0]).toContain("/project/project-1/exports/export-1/artifact");
    });

    it("deletes a persisted export artifact", async () => {
      const { deleteExportArtifact } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          deleted: true,
          exportRun: {
            id: "export-1",
            kind: "batch-zip",
            status: "done",
            filename: "chapter.zip",
            pageIndexes: [0],
            pageCount: 1,
            message: "Exported chapter.zip",
            createdAt: "2026-05-17T00:00:00.000Z",
            completedAt: "2026-05-17T00:00:00.000Z",
          },
        }), { status: 200 })
      );

      const result = await deleteExportArtifact("project-1", "export-1");

      expect(result.deleted).toBe(true);
      expect(result.exportRun?.artifact).toBeUndefined();
      expect(mockFetch.mock.calls[0][0]).toContain("/project/project-1/exports/export-1/artifact");
      expect(mockFetch.mock.calls[0][1]?.method).toBe("DELETE");
    });
  });

  describe("loadProject", () => {
    it("fetches project data", async () => {
      const { loadProject } = await import("../api/client.js");
      const { config } = await import("$lib/config.js");

      const mockProject = {
        projectId: "test-123",
        name: "Test Project",
        pages: [],
        currentPage: 0,
      };

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockProject), { status: 200 })
      );

      const result = await loadProject("test-123");

      expect(result).toEqual(mockProject);
      expect(mockFetch).toHaveBeenCalledWith(`${config.apiBase}/project/test-123`, expect.objectContaining({
        signal: expect.any(AbortSignal),
      }));
    });
  });

  describe("listProjects", () => {
    it("lists recent projects", async () => {
      const { listProjects } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          projects: [{
            projectId: "proj-1",
            name: "Chapter 1",
            createdAt: "2026-05-12T00:00:00.000Z",
            updatedAt: "2026-05-12T00:01:00.000Z",
            targetLang: "th",
            pageCount: 3,
            textLayerCount: 12,
          }],
        }), { status: 200 })
      );

      const result = await listProjects();

      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].name).toBe("Chapter 1");
      expect(mockFetch.mock.calls[0][0]).toContain("/project");
      // Back-compat: no workspace arg → no workspaceId query param.
      expect(String(mockFetch.mock.calls[0][0])).not.toContain("workspaceId");
    });

    it("scopes the listing to a workspace when given a workspaceId", async () => {
      const { listProjects } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [] }), { status: 200 })
      );

      await listProjects("ws with space/&");

      const url = String(mockFetch.mock.calls[0][0]);
      expect(url).toContain("/project?workspaceId=");
      // The workspace id is URL-encoded so special characters are safe in the query.
      expect(url).toContain(`workspaceId=${encodeURIComponent("ws with space/&")}`);
    });
  });

  describe("uploadImages", () => {
    it("sends FormData with files", async () => {
      const { uploadImages } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ imageIds: ["img1.png"] }), { status: 200 })
      );

      const file = new File(["test"], "test.png", { type: "image/png" });
      const result = await uploadImages("proj-1", [file]);

      expect(result.imageIds).toEqual(["img1.png"]);

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/images/proj-1/upload");
      expect(call[1]?.method).toBe("POST");
      // Body should be FormData
      expect(call[1]?.body).toBeInstanceOf(FormData);
    });

    it("handles multiple files", async () => {
      const { uploadImages } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ imageIds: ["img1.png", "img2.png"] }), { status: 200 })
      );

      const file1 = new File(["test1"], "test1.png", { type: "image/png" });
      const file2 = new File(["test2"], "test2.png", { type: "image/png" });
      const result = await uploadImages("proj-1", [file1, file2]);

      expect(result.imageIds).toEqual(["img1.png", "img2.png"]);
    });
  });

  describe("imageUrl", () => {
    it("constructs correct path", async () => {
      const { imageUrl } = await import("../api/client.js");
      const { config } = await import("$lib/config.js");

      const url = imageUrl("proj-1", "img1.png");
      expect(url).toBe(`${config.apiBase}/images/proj-1/img1.png`);
    });
  });

	  describe("listProjectImageAssets", () => {
	    it("fetches reusable image asset summaries", async () => {
	      const { listProjectImageAssets } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          assets: [{
            assetId: "img1.png",
            imageId: "img1.png",
            originalName: "stamp.png",
            mimeType: "image/png",
            sizeBytes: 100,
            sha256: "a".repeat(64),
            storageDriver: "local",
            storageKey: "projects/proj-1/images/img1.png",
            width: 80,
            height: 40,
            storageStatus: "released",
            moderationStatus: "passed",
            derivativeCount: 1,
            createdAt: "2026-05-12T00:00:00.000Z",
            updatedAt: "2026-05-12T00:00:00.000Z",
          }],
          storageQuota: {
            projectId: "proj-1",
            workspaceId: "proj-1",
            enforced: true,
            usedBytes: 100,
            originalBytes: 100,
            derivativeBytes: 0,
            exportArtifactBytes: 0,
            pendingBytes: 0,
            includedBytes: 1024,
            extraBytes: 0,
            limitBytes: 1024,
            remainingBytes: 924,
            percentUsed: 9.77,
            assetCount: 1,
            derivativeCount: 0,
            exportArtifactCount: 0,
          },
        }), { status: 200 })
      );

      const result = await listProjectImageAssets("proj-1");

      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].originalName).toBe("stamp.png");
	      expect(result.storageQuota?.usedBytes).toBe(100);
	      expect(mockFetch.mock.calls[0][0]).toContain("/images/proj-1/assets");
	    });

	    it("drains cursor pages so older assets remain visible", async () => {
	      const { listProjectImageAssets } = await import("../api/client.js");

	      mockFetch
	        .mockResolvedValueOnce(new Response(JSON.stringify({
	          assets: [{ assetId: "new", imageId: "new.png", originalName: "new.png" }],
	          nextCursor: "cursor-1",
	        }), { status: 200 }))
	        .mockResolvedValueOnce(new Response(JSON.stringify({
	          assets: [{ assetId: "old", imageId: "old.png", originalName: "old.png" }],
	        }), { status: 200 }));

	      const result = await listProjectImageAssets("proj-1");

	      expect(result.assets.map((asset) => asset.assetId)).toEqual(["new", "old"]);
	      expect(mockFetch.mock.calls[1][0]).toContain("cursor=cursor-1");
	    });
	  });

  describe("thumbnailUrl", () => {
    it("constructs a bounded derivative thumbnail path", async () => {
      const { thumbnailUrl } = await import("../api/client.js");
      const { config } = await import("$lib/config.js");

      const url = thumbnailUrl("proj-1", "img1.png", 160, 240);
      expect(url).toBe(`${config.apiBase}/images/proj-1/img1.png/thumbnail?width=160&height=240`);
    });

    it("adds fit=inside for the uncropped (aspect-preserving) variant", async () => {
      const { thumbnailUrl } = await import("../api/client.js");
      const { config } = await import("$lib/config.js");

      const url = thumbnailUrl("proj-1", "img1.png", 1600, 6400, "inside");
      expect(url).toBe(`${config.apiBase}/images/proj-1/img1.png/thumbnail?width=1600&height=6400&fit=inside`);
    });

    it("omits fit for the default cover variant (no regression for cards/grid)", async () => {
      const { thumbnailUrl } = await import("../api/client.js");
      const url = thumbnailUrl("proj-1", "img1.png", 192, 288, "cover");
      expect(url).not.toContain("fit=");
    });
  });

  describe("stripPreviewThumbnailUrl (webtoon strip preview variant)", () => {
    it("requests an uncropped fit=inside derivative sized to the column width × DPR", async () => {
      const { stripPreviewThumbnailUrl, STRIP_PREVIEW_MAX_WIDTH } = await import("../api/client.js");
      const original = globalThis.window?.devicePixelRatio;
      // Force a retina DPR so the preview is sized larger than the CSS column width.
      Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
      try {
        const url = stripPreviewThumbnailUrl("proj-1", "img1.png", 900);
        // It must be the downscaled fit=inside derivative, NOT the full image route.
        expect(url).toContain("/thumbnail?");
        expect(url).toContain("fit=inside");
        expect(url).not.toMatch(/\/images\/proj-1\/img1\.png(\?|$)/); // not the full editor_preview image
        const width = Number(new URL(url, "http://x").searchParams.get("width"));
        // 900 CSS × DPR 2 = 1800, capped at STRIP_PREVIEW_MAX_WIDTH; either way > the
        // old 512 cover cap (so retina stays crisp) and ≤ the cap.
        expect(width).toBeGreaterThan(900);
        expect(width).toBeLessThanOrEqual(STRIP_PREVIEW_MAX_WIDTH);
      } finally {
        if (original !== undefined) Object.defineProperty(window, "devicePixelRatio", { value: original, configurable: true });
      }
    });
  });

  describe("workspace storage library", () => {
    it("lists workspace storage assets with project/kind/sort query params", async () => {
      const { listWorkspaceStorageAssets } = await import("../api/client.js");
      const { config } = await import("$lib/config.js");
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({
          workspaceId: "ws-1",
          sort: "size",
          kind: null,
          projectId: "proj-9",
          assets: [],
          projects: [],
          totals: { assetCount: 0, originalBytes: 0, derivativeBytes: 0, totalBytes: 0, projectCount: 0 },
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const result = await listWorkspaceStorageAssets("ws-1", { projectId: "proj-9", kind: "uploaded", sort: "recent" });
      expect(result.workspaceId).toBe("ws-1");
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(`${config.apiBase}/storage/workspaces/ws-1/assets?`);
      expect(url).toContain("projectId=proj-9");
      expect(url).toContain("kind=uploaded");
      expect(url).toContain("sort=recent");
    });

    it("DELETEs an asset (force flag passed through) and returns freed bytes", async () => {
      const { deleteWorkspaceStorageAsset } = await import("../api/client.js");
      const { config } = await import("$lib/config.js");
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({
          ok: true, projectId: "proj-1", imageId: "img1.png",
          freedBytes: 1234, objectDeleted: true, wasReferenced: true, referencedByPages: [3],
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const result = await deleteWorkspaceStorageAsset("proj-1", "img1.png", { force: true });
      expect(result.freedBytes).toBe(1234);
      expect(result.referencedByPages).toEqual([3]);
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe(`${config.apiBase}/storage/projects/proj-1/assets/img1.png?force=true`);
      expect(call[1]?.method).toBe("DELETE");
    });

    it("surfaces a 409 asset_referenced as an ApiError carrying referencedByPages", async () => {
      const { deleteWorkspaceStorageAsset, ApiError } = await import("../api/client.js");
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({
          error: "Asset is still referenced by live pages",
          code: "asset_referenced",
          referencedByPages: [1, 2],
          requiresForce: true,
        }), { status: 409, headers: { "Content-Type": "application/json" } }),
      );

      try {
        await deleteWorkspaceStorageAsset("proj-1", "img1.png");
        throw new Error("expected delete to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiError = error as InstanceType<typeof ApiError>;
        expect(apiError.status).toBe(409);
        expect(apiError.code).toBe("asset_referenced");
        expect((apiError.body as { referencedByPages: number[] }).referencedByPages).toEqual([1, 2]);
      }
      // Unforced delete must NOT carry the force flag.
      expect(mockFetch.mock.calls[0][0]).not.toContain("force=true");
    });

    it("signedInsideThumbnailUrl mints a token and signs the fit=inside derivative", async () => {
      const { signedInsideThumbnailUrl, __clearAssetTokenCacheForTests } = await import("../api/client.js");
      __clearAssetTokenCacheForTests();
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ token: "tok-inside", purpose: "thumbnail", expiresAt: new Date(Date.now() + 300000).toISOString() }), {
          status: 200, headers: { "Content-Type": "application/json" },
        }),
      );
      const url = await signedInsideThumbnailUrl("proj-1", "img1.png", 320);
      expect(url).toContain("fit=inside");
      expect(url).toContain("assetToken=tok-inside");
    });
  });

  describe("signed asset tokens", () => {
    function tokenResponse(token: string, ttlSeconds = 300) {
      return new Response(JSON.stringify({
        token,
        purpose: "thumbnail",
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    beforeEach(async () => {
      const { __clearAssetTokenCacheForTests } = await import("../api/client.js");
      __clearAssetTokenCacheForTests();
    });

    it("mints a token via the authed access-token route and caches it", async () => {
      const { getAssetAccessToken } = await import("../api/client.js");
      const { config } = await import("$lib/config.js");
      mockFetch.mockResolvedValue(tokenResponse("tok-abc"));

      const first = await getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      const second = await getAssetAccessToken("proj-1", "img1.png", "thumbnail");

      expect(first).toBe("tok-abc");
      expect(second).toBe("tok-abc");
      // Cached: only ONE network mint for the repeated (project,image,purpose).
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const requestedUrl = mockFetch.mock.calls[0][0] as string;
      expect(requestedUrl).toBe(`${config.apiBase}/images/proj-1/img1.png/access-token?purpose=thumbnail`);
    });

    it("de-duplicates concurrent mints into a single request", async () => {
      const { getAssetAccessToken } = await import("../api/client.js");
      mockFetch.mockResolvedValue(tokenResponse("tok-concurrent"));

      const [a, b, c] = await Promise.all([
        getAssetAccessToken("proj-1", "img1.png", "thumbnail"),
        getAssetAccessToken("proj-1", "img1.png", "thumbnail"),
        getAssetAccessToken("proj-1", "img1.png", "thumbnail"),
      ]);

      expect([a, b, c]).toEqual(["tok-concurrent", "tok-concurrent", "tok-concurrent"]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("appends a signed assetToken to a backend thumbnail URL", async () => {
      const { signedThumbnailUrl } = await import("../api/client.js");
      const { config } = await import("$lib/config.js");
      mockFetch.mockResolvedValue(tokenResponse("tok-xyz"));

      const url = await signedThumbnailUrl("proj-1", "img1.png", 160, 240);
      expect(url).toBe(
        `${config.apiBase}/images/proj-1/img1.png/thumbnail?width=160&height=240&assetToken=tok-xyz`,
      );
    });

    it("returns the bare URL (no token) when minting fails", async () => {
      const { signedThumbnailUrl } = await import("../api/client.js");
      const { config } = await import("$lib/config.js");
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: "Project not found" }), { status: 404 }));

      const url = await signedThumbnailUrl("proj-1", "img1.png", 160, 240);
      // Degrades gracefully → onerror placeholder fires, no token leaked.
      expect(url).toBe(`${config.apiBase}/images/proj-1/img1.png/thumbnail?width=160&height=240`);
      expect(url).not.toContain("assetToken");
    });

    it("passes blob: and non-API URLs through untouched (no mint)", async () => {
      const { signedAssetUrl } = await import("../api/client.js");

      const blob = await signedAssetUrl("blob:abc123", "proj-1", "img1.png", "editor_preview");
      expect(blob).toBe("blob:abc123");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("re-mints when forceRefresh is set", async () => {
      const { getAssetAccessToken } = await import("../api/client.js");
      mockFetch
        .mockResolvedValueOnce(tokenResponse("tok-1"))
        .mockResolvedValueOnce(tokenResponse("tok-2"));

      const first = await getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      const refreshed = await getAssetAccessToken("proj-1", "img1.png", "thumbnail", true);

      expect(first).toBe("tok-1");
      expect(refreshed).toBe("tok-2");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    // P1 (security): a signed asset token minted under user A's bearer identity
    // must NOT survive a logout. clearApiAccessToken() must drop the cache so the
    // next lookup re-mints under whoever is authed next.
    it("re-mints after clearApiAccessToken() drops user A's cached token", async () => {
      const { getAssetAccessToken, setApiAccessToken, clearApiAccessToken } = await import("../api/client.js");
      mockFetch
        .mockResolvedValueOnce(tokenResponse("tok-A"))
        .mockResolvedValueOnce(tokenResponse("tok-B"));

      setApiAccessToken("access-A");
      const asA = await getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(asA).toBe("tok-A");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Logout: cache must be cleared, not reused.
      clearApiAccessToken();
      const afterLogout = await getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(afterLogout).toBe("tok-B");
      // A SECOND network mint proves user A's token was not served from cache.
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    // P1 (security): an account switch (setApiAccessToken to a DIFFERENT value)
    // must also invalidate the previous identity's cached asset tokens.
    it("re-mints after setApiAccessToken() switches to a different identity", async () => {
      const { getAssetAccessToken, setApiAccessToken } = await import("../api/client.js");
      mockFetch
        .mockResolvedValueOnce(tokenResponse("tok-A"))
        .mockResolvedValueOnce(tokenResponse("tok-B"));

      setApiAccessToken("access-A");
      const asA = await getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(asA).toBe("tok-A");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Account switch → different bearer → cache cleared.
      setApiAccessToken("access-B");
      const asB = await getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(asB).toBe("tok-B");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    // P1: re-setting the SAME token (e.g. an idempotent re-hydrate) must NOT bust
    // the cache — only an actual identity change should re-mint.
    it("keeps the cache when setApiAccessToken() is called with the same token", async () => {
      const { getAssetAccessToken, setApiAccessToken } = await import("../api/client.js");
      mockFetch.mockResolvedValue(tokenResponse("tok-same"));

      setApiAccessToken("access-A");
      const first = await getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(first).toBe("tok-same");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Same identity re-applied → cache preserved → no extra mint.
      setApiAccessToken("access-A");
      const second = await getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(second).toBe("tok-same");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // P2: the token cache is bounded. After minting more than the cap of distinct
    // assets, the OLDEST entry is evicted, so re-requesting it re-mints (a new
    // network call) while a recently-minted entry stays cached.
    it("evicts the oldest entry once the cache exceeds its cap", async () => {
      const { getAssetAccessToken } = await import("../api/client.js");
      const CAP = 256;
      let mintCount = 0;
      // Every mint returns a distinct token keyed to its request URL's imageId.
      mockFetch.mockImplementation(() => {
        mintCount += 1;
        return Promise.resolve(tokenResponse(`tok-${mintCount}`));
      });

      // Mint CAP + 1 distinct assets → the very first asset (img-0) is the oldest
      // and must have been evicted to make room for img-256.
      for (let i = 0; i <= CAP; i += 1) {
        await getAssetAccessToken("proj-1", `img-${i}.png`, "thumbnail");
      }
      expect(mintCount).toBe(CAP + 1);

      // A recently-minted asset (img-256, the newest) is still cached → no re-mint.
      const cachedRecent = await getAssetAccessToken("proj-1", `img-${CAP}.png`, "thumbnail");
      expect(cachedRecent).toBe(`tok-${CAP + 1}`);
      expect(mintCount).toBe(CAP + 1);

      // The oldest asset (img-0) was evicted → re-requesting it issues a NEW mint.
      await getAssetAccessToken("proj-1", "img-0.png", "thumbnail");
      expect(mintCount).toBe(CAP + 2);
    });

    // P1 (security RACE — the generation/epoch crux): user A starts a mint that
    // HANGS on the network. Mid-flight, an account switch / logout clears the
    // cache. When A's mint finally resolves it must NOT repopulate the (now
    // user-B) cache. A later user-B lookup for the SAME asset must trigger a
    // FRESH network mint and must receive user-B's token, never A's.
    it("does not let user A's in-flight mint repopulate the cache after an account switch", async () => {
      const { getAssetAccessToken, setApiAccessToken } = await import("../api/client.js");

      // Deferred fetch so A's mint hangs until we explicitly resolve it.
      let resolveAFetch!: (res: Response) => void;
      const aFetch = new Promise<Response>((resolve) => {
        resolveAFetch = resolve;
      });
      mockFetch
        // 1st call (user A) hangs on this deferred promise.
        .mockImplementationOnce(() => aFetch)
        // 2nd call (user B's fresh lookup) resolves immediately with B's token.
        .mockResolvedValueOnce(tokenResponse("tok-B"));

      setApiAccessToken("access-A");
      // Start A's mint but DO NOT await it yet (it is hanging).
      const aPromise = getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Account switch happens WHILE A's mint is still pending → cache cleared,
      // generation bumped.
      setApiAccessToken("access-B");

      // Now let A's mint resolve. A's own caller still gets A's token (its own
      // in-flight call resolves), but the token must NOT be persisted.
      resolveAFetch(tokenResponse("tok-A"));
      const aResult = await aPromise;
      expect(aResult).toBe("tok-A"); // A's own caller resolves fine.

      // User B looks up the SAME asset. If A's stale token had leaked into the
      // cache, this would return "tok-A" with NO new network call. It must
      // instead trigger a fresh mint and return B's token.
      const bResult = await getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(bResult).toBe("tok-B");
      // Request-count oracle: a SECOND network mint proves A's token was not
      // served from cache.
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    // P1 (security RACE — logout variant): same race, but the identity change is
    // a clearApiAccessToken() logout rather than a switch.
    it("does not let user A's in-flight mint repopulate the cache after logout", async () => {
      const { getAssetAccessToken, setApiAccessToken, clearApiAccessToken } = await import("../api/client.js");

      let resolveAFetch!: (res: Response) => void;
      const aFetch = new Promise<Response>((resolve) => {
        resolveAFetch = resolve;
      });
      mockFetch
        .mockImplementationOnce(() => aFetch)
        .mockResolvedValueOnce(tokenResponse("tok-B"));

      setApiAccessToken("access-A");
      const aPromise = getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      clearApiAccessToken(); // logout mid-flight → cache cleared, generation bumped.

      resolveAFetch(tokenResponse("tok-A"));
      expect(await aPromise).toBe("tok-A"); // A's own caller still resolves.

      setApiAccessToken("access-B");
      const bResult = await getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(bResult).toBe("tok-B");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    // P1 (inflight-delete guard): A's mint is pending; a clear happens; user B
    // then starts a NEW inflight mint for the SAME key. When A's mint resolves,
    // its finally{} must NOT delete user B's freshly-registered inflight entry
    // (the guard checks both generation AND promise identity). Concurrent B
    // callers must therefore still de-dupe onto B's single inflight request.
    it("A's resolution after a clear does not clobber user B's fresh inflight entry for the same key", async () => {
      const { getAssetAccessToken, setApiAccessToken } = await import("../api/client.js");

      // A's fetch hangs.
      let resolveAFetch!: (res: Response) => void;
      const aFetch = new Promise<Response>((resolve) => {
        resolveAFetch = resolve;
      });
      // B's fetch also hangs (so we can observe in-flight de-dup while it is
      // pending) — then we resolve it.
      let resolveBFetch!: (res: Response) => void;
      const bFetch = new Promise<Response>((resolve) => {
        resolveBFetch = resolve;
      });
      mockFetch
        .mockImplementationOnce(() => aFetch) // user A
        .mockImplementationOnce(() => bFetch); // user B (first/only B mint)

      setApiAccessToken("access-A");
      const aPromise = getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Clear (account switch) while A is pending → generation bumped, inflight
      // map emptied.
      setApiAccessToken("access-B");

      // User B starts a NEW inflight mint for the SAME key (B's fetch hangs).
      const bPromise1 = getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Now A's hung mint resolves. Its finally{} must NOT delete B's inflight
      // entry (guarded by generation + promise identity).
      resolveAFetch(tokenResponse("tok-A"));
      expect(await aPromise).toBe("tok-A");

      // A concurrent B caller for the same key must still de-dupe onto B's
      // single inflight request — proving B's inflight entry survived A's
      // finally{}. If A had clobbered it, this would start a THIRD mint.
      const bPromise2 = getAssetAccessToken("proj-1", "img1.png", "thumbnail");
      expect(mockFetch).toHaveBeenCalledTimes(2); // still 2 → de-duped onto B.

      resolveBFetch(tokenResponse("tok-B"));
      expect(await bPromise1).toBe("tok-B");
      expect(await bPromise2).toBe("tok-B");
      // Final oracle: exactly 2 mints total (A + B), no clobber-induced third.
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    // P2 (true LRU on HIT, not just on insert): read an OLD entry (a cache hit
    // bumps its recency), then overflow the cap. The recently-HIT old entry must
    // survive; a different, truly-least-recently-used entry must be evicted.
    it("refreshes recency on a cache hit so a frequently-read old entry survives cap pressure", async () => {
      const { getAssetAccessToken } = await import("../api/client.js");
      const CAP = 256;
      let mintCount = 0;
      mockFetch.mockImplementation(() => {
        mintCount += 1;
        return Promise.resolve(tokenResponse(`tok-${mintCount}`));
      });

      // Fill the cache exactly to CAP with img-0 .. img-255 (img-0 oldest).
      for (let i = 0; i < CAP; i += 1) {
        await getAssetAccessToken("proj-1", `img-${i}.png`, "thumbnail");
      }
      expect(mintCount).toBe(CAP);

      // HIT the OLDEST entry (img-0). With LRU-on-hit this moves img-0 to the
      // most-recent position; img-1 becomes the new least-recently-used.
      const hit = await getAssetAccessToken("proj-1", "img-0.png", "thumbnail");
      expect(hit).toBe("tok-1"); // cached, no new mint.
      expect(mintCount).toBe(CAP);

      // Insert ONE new asset → over cap → evict the current LRU. With LRU-on-hit
      // the victim is img-1 (NOT the freshly-hit img-0).
      await getAssetAccessToken("proj-1", `img-${CAP}.png`, "thumbnail");
      expect(mintCount).toBe(CAP + 1);

      // img-0 (recently hit) must still be cached → no re-mint.
      const stillCached = await getAssetAccessToken("proj-1", "img-0.png", "thumbnail");
      expect(stillCached).toBe("tok-1");
      expect(mintCount).toBe(CAP + 1);

      // img-1 (the true LRU) must have been evicted → a NEW mint.
      await getAssetAccessToken("proj-1", "img-1.png", "thumbnail");
      expect(mintCount).toBe(CAP + 2);
    });
  });

  describe("usage", () => {
    it("fetches storage and egress summaries", async () => {
      const { getProjectStorageUsage, getProjectEgressUsage } = await import("../api/client.js");

      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            storageQuota: {
              projectId: "proj-1",
              workspaceId: "proj-1",
              enforced: true,
              usedBytes: 128,
              originalBytes: 64,
              derivativeBytes: 64,
              exportArtifactBytes: 0,
              pendingBytes: 0,
              includedBytes: 1024,
              extraBytes: 0,
              limitBytes: 1024,
              remainingBytes: 896,
              percentUsed: 12.5,
              assetCount: 1,
              derivativeCount: 1,
              exportArtifactCount: 0,
            },
          }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            egress: {
              projectId: "proj-1",
              windowMs: 3600000,
              windowStart: 0,
              windowEnd: 3600000,
              totalRequests: 2,
              totalBytes: 256,
              limitBytes: 0,
              enforced: false,
              remainingBytes: 0,
              byPurpose: [{ purpose: "thumbnail", requests: 2, bytes: 256 }],
              byAsset: [{ imageId: "img1.png", requests: 2, bytes: 256 }],
            },
          }), { status: 200 })
        );

      const storage = await getProjectStorageUsage("proj-1");
      const egress = await getProjectEgressUsage("proj-1");

      expect(storage.storageQuota.usedBytes).toBe(128);
      expect(egress.egress.totalRequests).toBe(2);
      expect(mockFetch.mock.calls[0][0]).toContain("/images/proj-1/storage-usage");
      expect(mockFetch.mock.calls[1][0]).toContain("/images/proj-1/egress-usage");
    });

    it("records export usage with idempotency metadata", async () => {
      const { recordExportUsage } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          eventId: "event-1",
          usage: {
            workspaceId: "proj-1",
            projectId: "proj-1",
            planId: "prototype",
            enforced: true,
            daily: {},
            monthly: {},
            eventCount: 1,
          },
        }), { status: 200 })
      );

	      const result = await recordExportUsage("proj-1", {
	        bytes: 1234,
	        pageIndexes: [0, 1],
	        pageCount: 2,
	        filename: "chapter.zip",
	        exportKind: "batch-zip",
	        targetProfile: "public-export",
	        idempotencyKey: "export-key",
	      });

      expect(result.eventId).toBe("event-1");
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/usage/proj-1/export");
      expect(call[1]?.method).toBe("POST");
      expect(call[1]?.headers).toEqual(expect.objectContaining({ "Content-Type": "application/json" }));
	      expect(JSON.parse(call[1]?.body)).toEqual({
	        bytes: 1234,
	        pageIndexes: [0, 1],
	        pageCount: 2,
	        filename: "chapter.zip",
	        exportKind: "batch-zip",
	        targetProfile: "public-export",
	        idempotencyKey: "export-key",
	      });
    });
  });

  describe("submitAiJob", () => {
    it("sends all required fields", async () => {
      const { submitAiJob } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          jobId: "job-1",
          prompt: "test",
          tier: "sfx-pro",
          costEstimate: {
            tier: "sfx-pro",
            providerHint: "python-worker",
            currency: "THB",
            megapixels: 0.01,
            estimatedThb: 5,
            reserveThb: 5.75,
            pricingVersion: "prototype-2026-05-12",
          },
        }), { status: 200 })
      );

      const result = await submitAiJob({
        projectId: "proj-1",
        imageId: "img1.png",
        crop: { x: 0, y: 0, w: 100, h: 100 },
        lang: "th",
        customPrompt: "translate this",
        translateSfx: true,
        tier: "sfx-pro",
        textLayers: ["layer1", "layer2"],
      });

      expect(result.jobId).toBe("job-1");
      expect(result.costEstimate?.reserveThb).toBe(5.75);

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/ai/translate");
      expect(call[1]?.headers).toEqual(expect.objectContaining({
        "Content-Type": "application/json",
        "X-Project-Id": "proj-1",
        "X-AI-Tier": "sfx-pro",
      }));
      const body = JSON.parse(call[1]?.body);
      expect(body.projectId).toBe("proj-1");
      expect(body.lang).toBe("th");
      expect(body.crop).toEqual({ x: 0, y: 0, w: 100, h: 100 });
      expect(body.customPrompt).toBe("translate this");
      expect(body.translateSfx).toBe(true);
      expect(body.tier).toBe("sfx-pro");
      expect(body.textLayers).toEqual(["layer1", "layer2"]);
    });

    it("forwards the chosen AI image quality in the payload", async () => {
      const { submitAiJob } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: "job-q", prompt: "test", tier: "sfx-pro" }), { status: 200 })
      );

      await submitAiJob({
        projectId: "proj-1",
        imageId: "img1.png",
        crop: { x: 0, y: 0, w: 100, h: 100 },
        lang: "th",
        tier: "sfx-pro",
        quality: "high",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.quality).toBe("high");
    });

    it("sends a custom idempotency key as a header without leaking it into the payload", async () => {
      const { submitAiJob } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: "job-rerun", prompt: "test", tier: "sfx-pro" }), { status: 200 })
      );

      await submitAiJob({
        projectId: "proj-1",
        imageId: "img1.png",
        crop: { x: 0, y: 0, w: 100, h: 100 },
        lang: "th",
        tier: "sfx-pro",
        idempotencyKey: "ai-marker-rerun:proj-1:marker-1:fresh",
      });

      const call = mockFetch.mock.calls[0];
      expect(call[1]?.headers).toEqual(expect.objectContaining({
        "Idempotency-Key": "ai-marker-rerun:proj-1:marker-1:fresh",
      }));
      expect(JSON.parse(call[1]?.body).idempotencyKey).toBeUndefined();
    });

    it("reruns an AI review marker with AI submit headers and no payload idempotency leak", async () => {
      const { rerunAiReviewMarker } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          jobId: "job-rerun",
          prompt: "test",
          tier: "sfx-pro",
          reused: false,
          marker: { id: "marker-rerun" },
          markers: [],
          activityLog: [],
        }), { status: 200 })
      );

      const result = await rerunAiReviewMarker(
        "proj-1",
        "marker-1",
        { lang: "th" },
        "ai-marker-rerun:proj-1:marker-1:fresh",
        "sfx-pro",
      );

      expect(result.jobId).toBe("job-rerun");
      expect(result.marker.id).toBe("marker-rerun");
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/project/proj-1/ai-markers/marker-1/rerun");
      expect(call[1]?.headers).toEqual(expect.objectContaining({
        "Content-Type": "application/json",
        "X-Project-Id": "proj-1",
        "X-AI-Tier": "sfx-pro",
        "Idempotency-Key": "ai-marker-rerun:proj-1:marker-1:fresh",
      }));
      const body = JSON.parse(call[1]?.body);
      expect(body).toEqual({ lang: "th" });
      expect(body.idempotencyKey).toBeUndefined();
    });

    it("omits optional fields when not provided", async () => {
      const { submitAiJob } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: "job-1", prompt: "test" }), { status: 200 })
      );

      const result = await submitAiJob({
        projectId: "proj-1",
        imageId: "img1.png",
        crop: { x: 0, y: 0, w: 100, h: 100 },
        lang: "th",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(mockFetch.mock.calls[0][1].headers).toEqual(expect.objectContaining({
        "X-Project-Id": "proj-1",
        "X-AI-Tier": "sfx-pro",
      }));
      expect(body.customPrompt).toBeUndefined();
      expect(body.textLayers).toBeUndefined();
      expect(body.translateSfx).toBeUndefined();
    });

    it("rejects accepted responses that did not queue an AI job", async () => {
      const { submitAiJob } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Prompt requires review", code: "prompt_needs_review" }), { status: 202 })
      );

      await expect(submitAiJob({
        projectId: "proj-1",
        imageId: "img1.png",
        crop: { x: 0, y: 0, w: 100, h: 100 },
        lang: "th",
        tier: "sfx-pro",
      })).rejects.toThrow("Prompt requires review");
    });
  });

  describe("applyAiResultToPage", () => {
    it("treats the retired flatten endpoint as an error instead of blessing page edits", async () => {
      const { applyAiResultToPage } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "AI result page flattening is retired",
          code: "ai_result_flatten_retired",
        }), { status: 410 })
      );

      await expect(applyAiResultToPage("proj-1", 2, "result_job.png"))
        .rejects.toMatchObject({
          name: "ApiError",
          status: 410,
          code: "ai_result_flatten_retired",
        });

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/project/proj-1/pages/2/ai-result");
      expect(call[1]?.method).toBe("PATCH");
      expect(call[1]?.headers).toEqual(expect.objectContaining({ "Content-Type": "application/json" }));
      expect(JSON.parse(call[1]?.body)).toEqual({ resultImageId: "result_job.png" });
    });
  });

  describe("getAiStatus", () => {
    it("returns job status", async () => {
      const { getAiStatus } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "done", resultImageId: "result.png" }), { status: 200 })
      );

      const result = await getAiStatus("job-1");
      expect(result.status).toBe("done");
      expect(result.resultImageId).toBe("result.png");
    });

    it("handles job errors", async () => {
      const { getAiStatus } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "error", error: "Failed to process" }), { status: 200 })
      );

      const result = await getAiStatus("job-1");
      expect(result.status).toBe("error");
      expect(result.error).toBe("Failed to process");
    });
  });

  describe("getAiCapabilities", () => {
    it("returns tier provider readiness", async () => {
      const { getAiCapabilities } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          tiers: [
            { id: "sfx-pro", label: "SFX Pro", provider: "python-worker", available: true, reason: null, detail: "Ready" },
            { id: "clean-pro", label: "Clean Pro", provider: "gemini", available: false, reason: "openrouter_not_configured", detail: "Needs key" },
          ],
        }), { status: 200 })
      );

      const result = await getAiCapabilities({ projectId: "project-1", lang: "th" });
      expect(result.tiers[0]).toMatchObject({ id: "sfx-pro", available: true });
      expect(result.tiers[1]).toMatchObject({ id: "clean-pro", reason: "openrouter_not_configured" });
      expect(mockFetch.mock.calls[0][0]).toContain("/ai/capabilities?projectId=project-1&lang=th");
    });
  });

  describe("importTranslations", () => {
    it("sends translation entries", async () => {
      const { importTranslations } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          imported: 5,
          skipped: 1,
          pages: [{ pageIndex: 0, imageId: "img-1", imageName: "image-01.webp", imported: 5 }],
        }), { status: 200 })
      );

      const entries = [
        { id: "1", text: "Hello", translation: "สวัสดี" },
        { id: "2", text: "World", translation: "โลก" }
      ];

      const result = await importTranslations("proj-1", entries);

      expect(result.imported).toBe(5);
      expect(result.skipped).toBe(1);
      expect(result.pages?.[0].pageIndex).toBe(0);

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/project/proj-1/import-json");
      const body = JSON.parse(call[1]?.body);
      expect(body.entries).toHaveLength(2);
    });
  });

  describe("project versions", () => {
    it("lists project versions", async () => {
      const { getProjectVersions } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          versions: [{
            versionId: "2026-05-12T00-00-00Z_v1",
            projectId: "proj-1",
            name: "Chapter 1",
            source: "save",
            createdAt: "2026-05-12T00:00:00.000Z",
            pageCount: 3,
            textLayerCount: 12,
          }],
        }), { status: 200 })
      );

      const result = await getProjectVersions("proj-1");

      expect(result.versions).toHaveLength(1);
      expect(result.versions[0].source).toBe("save");
      expect(mockFetch.mock.calls[0][0]).toContain("/project/proj-1/versions");
    });

    it("restores a project version", async () => {
      const { restoreProjectVersion } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, restoredVersionId: "version-1" }), { status: 200 })
      );

      const result = await restoreProjectVersion("proj-1", "version-1");

      expect(result.ok).toBe(true);
      expect(result.restoredVersionId).toBe("version-1");
      expect(mockFetch.mock.calls[0][0]).toContain("/project/proj-1/versions/version-1/restore");
      expect(mockFetch.mock.calls[0][1]?.method).toBe("POST");
      // No scope → no JSON body (legacy full restore).
      expect(mockFetch.mock.calls[0][1]?.body).toBeUndefined();
    });

    it("W3.9: sends a scope body for a selective per-layer restore", async () => {
      const { restoreProjectVersion } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, restoredVersionId: "version-1", scope: "layer", restoredLayerKind: "text" }), { status: 200 })
      );

      const result = await restoreProjectVersion("proj-1", "version-1", { pageIndex: 2, layerId: "layer-x" });

      expect(result.scope).toBe("layer");
      const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
      expect(body).toEqual({ pageIndex: 2, layerId: "layer-x" });
    });

    it("W3.9: compares two project versions", async () => {
      const { compareProjectVersions } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            baseVersion: null,
            targetVersion: { versionId: "version-1", projectId: "proj-1", name: "n", source: "manual", createdAt: "", pageCount: 1, textLayerCount: 0 },
            diff: { base: {}, target: {}, pageDelta: 0, textLayerDelta: 0, imageLayerDelta: 0, addedPageCount: 0, removedPageCount: 0, changedPageCount: 0, pages: [] },
          }),
          { status: 200 }
        )
      );

      const result = await compareProjectVersions("proj-1", "version-1", "version-0");

      expect(result.targetVersion.versionId).toBe("version-1");
      const url = String(mockFetch.mock.calls[0][0]);
      expect(url).toContain("/project/proj-1/versions/compare?");
      expect(url).toContain("target=version-1");
      expect(url).toContain("base=version-0");
    });

    it("loads project version detail", async () => {
      const { getProjectVersionDetail } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          version: {
            versionId: "version-1",
            projectId: "proj-1",
            name: "Chapter 1",
            source: "save",
            createdAt: "2026-05-12T00:00:00.000Z",
            pageCount: 1,
            textLayerCount: 2,
          },
          diff: {
            current: { name: "Chapter 1", pageCount: 1, textLayerCount: 3, pages: [] },
            snapshot: { name: "Chapter 1", pageCount: 1, textLayerCount: 2, pages: [] },
            pageDelta: 0,
            textLayerDelta: -1,
            changedPages: [{
              pageIndex: 0,
              label: "page.png",
              currentTextLayerCount: 3,
              snapshotTextLayerCount: 2,
            }],
            changedPageCount: 1,
          },
          reviews: [],
        }), { status: 200 })
      );

      const result = await getProjectVersionDetail("proj-1", "version-1");

      expect(result.version.versionId).toBe("version-1");
      expect(result.diff.textLayerDelta).toBe(-1);
      expect(mockFetch.mock.calls[0][0]).toContain("/project/proj-1/versions/version-1");
    });

    it("creates and updates version reviews", async () => {
      const { createVersionReview, updateVersionReview } = await import("../api/client.js");

      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            review: { id: "review-1", versionId: "version-1", status: "open", body: "Check @lead", requester: "local-user", mentions: ["lead"], createdAt: "", updatedAt: "" },
            reviews: [],
            activityLog: [],
            items: [],
          }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            review: { id: "review-1", versionId: "version-1", status: "approved", body: "Looks good", requester: "local-user", reviewer: "lead", createdAt: "", updatedAt: "", decidedAt: "" },
            reviews: [],
            activityLog: [],
            items: [],
          }), { status: 200 })
        );

      const created = await createVersionReview("proj-1", "version-1", { body: "Check @lead" });
      const updated = await updateVersionReview("proj-1", "version-1", "review-1", { status: "approved", body: "Looks good" });

      expect(created.review.mentions).toEqual(["lead"]);
      expect(updated.review.status).toBe("approved");
      expect(mockFetch.mock.calls[0][0]).toContain("/project/proj-1/versions/version-1/reviews");
      expect(mockFetch.mock.calls[0][1]?.method).toBe("POST");
      expect(mockFetch.mock.calls[1][0]).toContain("/project/proj-1/versions/version-1/reviews/review-1");
      expect(mockFetch.mock.calls[1][1]?.method).toBe("PATCH");
    });

    it("loads project workflow", async () => {
      const { getProjectWorkflow } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          tasks: [{ id: "task-1", type: "translate", status: "todo", pageIndex: 0, title: "Translate page 1", createdAt: "", updatedAt: "" }],
          activityLog: [{ id: "event-1", type: "project_created", message: "Created", actor: "local-user", createdAt: "" }],
        }), { status: 200 })
      );

      const result = await getProjectWorkflow("proj-1");

      expect(result.tasks[0].type).toBe("translate");
      expect(result.activityLog[0].message).toBe("Created");
      expect(mockFetch.mock.calls[0][0]).toContain("/project/proj-1/workflow");
    });

    it("updates project task status", async () => {
      const { updateTaskStatus } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          task: { id: "task-1", type: "translate", status: "doing", pageIndex: 0, title: "Translate page 1", createdAt: "", updatedAt: "" },
          activityLog: [],
        }), { status: 200 })
      );

      const result = await updateTaskStatus("proj-1", "task-1", "doing");

      expect(result.task.status).toBe("doing");
      expect(mockFetch.mock.calls[0][0]).toContain("/project/proj-1/tasks/task-1");
      expect(mockFetch.mock.calls[0][1]?.method).toBe("PATCH");
      expect(JSON.parse(mockFetch.mock.calls[0][1]?.body).status).toBe("doing");
    });

    it("bulk updates project task priority", async () => {
      const { bulkUpdateProjectTasks } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          tasks: [
            { id: "task-1", type: "translate", status: "todo", priority: "urgent", pageIndex: 0, title: "Translate page 1", createdAt: "", updatedAt: "" },
            { id: "task-2", type: "typeset", status: "review", priority: "urgent", pageIndex: 1, title: "Typeset page 2", createdAt: "", updatedAt: "" },
          ],
          activityLog: [],
          changedCount: 2,
          missingTaskIds: [],
        }), { status: 200 })
      );

      const result = await bulkUpdateProjectTasks("proj-1", {
        taskIds: ["task-1", "task-2"],
        priority: "urgent",
      });

      expect(result.changedCount).toBe(2);
      expect(result.tasks.every((task) => task.priority === "urgent")).toBe(true);
      expect(mockFetch.mock.calls[0][0]).toContain("/project/proj-1/tasks/bulk");
      expect(mockFetch.mock.calls[0][1]?.method).toBe("PATCH");
      expect(JSON.parse(mockFetch.mock.calls[0][1]?.body).taskIds).toEqual(["task-1", "task-2"]);
    });

    it("updates project task assignee", async () => {
      const { updateProjectTask } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          task: { id: "task-1", type: "typeset", status: "todo", assignee: "typesetter-a", pageIndex: 0, title: "Typeset page 1", createdAt: "", updatedAt: "" },
          activityLog: [],
        }), { status: 200 })
      );

      const result = await updateProjectTask("proj-1", "task-1", { assignee: "typesetter-a" });

      expect(result.task.assignee).toBe("typesetter-a");
      expect(mockFetch.mock.calls[0][0]).toContain("/project/proj-1/tasks/task-1");
      expect(mockFetch.mock.calls[0][1]?.method).toBe("PATCH");
      expect(JSON.parse(mockFetch.mock.calls[0][1]?.body).assignee).toBe("typesetter-a");
    });

    it("creates and resolves project comments", async () => {
      const { createProjectComment, updateProjectComment } = await import("../api/client.js");

      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            comment: { id: "comment-1", pageIndex: 0, body: "Check edge @reviewer", author: "local-user", mentions: ["reviewer"], status: "open", createdAt: "", updatedAt: "" },
            comments: [],
            activityLog: [],
          }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            comment: { id: "comment-1", pageIndex: 0, body: "Check edge", author: "local-user", status: "resolved", createdAt: "", updatedAt: "" },
            comments: [],
            activityLog: [],
          }), { status: 200 })
        );

      const created = await createProjectComment("proj-1", {
        pageIndex: 0,
        body: "Check edge",
        region: { x: 10, y: 20, w: 30, h: 40 },
      });
      const resolved = await updateProjectComment("proj-1", "comment-1", { status: "resolved" });

      expect(created.comment.status).toBe("open");
      expect(created.comment.mentions).toEqual(["reviewer"]);
      expect(resolved.comment.status).toBe("resolved");
      expect(mockFetch.mock.calls[0][0]).toContain("/project/proj-1/comments");
      expect(JSON.parse(mockFetch.mock.calls[0][1]?.body).region).toEqual({ x: 10, y: 20, w: 30, h: 40 });
      expect(mockFetch.mock.calls[1][0]).toContain("/project/proj-1/comments/comment-1");
    });

    it("creates page review decisions", async () => {
      const { createProjectReviewDecision } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          decision: { id: "review-1", pageIndex: 0, status: "approved", actor: "local-user", createdAt: "", updatedAt: "" },
          decisions: [],
          tasks: [],
          activityLog: [],
        }), { status: 200 })
      );

      const result = await createProjectReviewDecision("proj-1", {
        pageIndex: 0,
        status: "approved",
        body: "Looks good",
      });

      expect(result.decision.status).toBe("approved");
      expect(mockFetch.mock.calls[0][0]).toContain("/project/proj-1/review-decisions");
      expect(JSON.parse(mockFetch.mock.calls[0][1]?.body).body).toBe("Looks good");
    });

    it("loads workspace feed and creates handoff messages", async () => {
      const { getWorkspaceFeed, createWorkspaceMessage } = await import("../api/client.js");

      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            items: [{ id: "message-1", kind: "message", sourceId: "note-1", title: "Handoff note", detail: "Check this", createdAt: "" }],
            messages: [],
            activityLog: [],
          }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            message: { id: "note-1", pageIndex: 0, body: "Check this @reviewer", author: "local-user", mentions: ["reviewer"], createdAt: "", updatedAt: "" },
            messages: [],
            items: [],
            activityLog: [],
          }), { status: 200 })
        );

      const feed = await getWorkspaceFeed("proj-1");
      const message = await createWorkspaceMessage("proj-1", { pageIndex: 0, body: "Check this @reviewer" });

      expect(feed.items[0].kind).toBe("message");
      expect(message.message.mentions).toEqual(["reviewer"]);
      expect(mockFetch.mock.calls[0][0]).toContain("/project/proj-1/workspace-feed");
      expect(mockFetch.mock.calls[1][0]).toContain("/project/proj-1/workspace-messages");
    });

    it("creates, updates, and links AI review markers", async () => {
      const {
        createAiReviewMarker,
        createAiReviewMarkerComment,
        getAiReviewMarkers,
        linkAiReviewMarkerReviewTask,
        updateAiReviewMarker,
      } = await import("../api/client.js");

      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            markers: [{ id: "marker-1", jobId: "job-1", pageIndex: 0, imageId: "img-1", region: { x: 0, y: 0, w: 100, h: 80 }, status: "needs_review", tier: "clean-pro", createdAt: "", updatedAt: "" }],
          }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            marker: { id: "marker-1", jobId: "job-1", pageIndex: 0, imageId: "img-1", region: { x: 0, y: 0, w: 100, h: 80 }, status: "processing", tier: "clean-pro", createdAt: "", updatedAt: "" },
            markers: [],
            activityLog: [],
          }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            marker: { id: "marker-1", jobId: "job-1", pageIndex: 0, imageId: "img-1", region: { x: 0, y: 0, w: 100, h: 80 }, status: "accepted", tier: "clean-pro", createdAt: "", updatedAt: "" },
            markers: [],
            activityLog: [],
          }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            marker: { id: "marker-1", jobId: "job-1", pageIndex: 0, imageId: "img-1", region: { x: 0, y: 0, w: 100, h: 80 }, status: "accepted", tier: "clean-pro", linkedCommentIds: ["comment-1"], createdAt: "", updatedAt: "" },
            comment: { id: "comment-1", pageIndex: 0, body: "Check edge", author: "local-user", status: "open", createdAt: "", updatedAt: "" },
            markers: [],
            comments: [],
            activityLog: [],
          }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            marker: { id: "marker-1", jobId: "job-1", pageIndex: 0, imageId: "img-1", region: { x: 0, y: 0, w: 100, h: 80 }, status: "accepted", tier: "clean-pro", linkedTaskIds: ["task-1"], createdAt: "", updatedAt: "" },
            task: { id: "task-1", type: "review", status: "review", pageIndex: 0, title: "Review page 1", createdAt: "", updatedAt: "" },
            markers: [],
            tasks: [],
            activityLog: [],
          }), { status: 200 })
        );

      const listed = await getAiReviewMarkers("proj-1");
      const created = await createAiReviewMarker("proj-1", {
        jobId: "job-1",
        pageIndex: 0,
        imageId: "img-1",
        region: { x: 0, y: 0, w: 100, h: 80 },
        status: "processing",
        tier: "clean-pro",
      });
      const updated = await updateAiReviewMarker("proj-1", "marker-1", {
        status: "accepted",
        linkedCommentIds: ["comment-1"],
        linkedTaskIds: ["task-1"],
      });
      const comment = await createAiReviewMarkerComment("proj-1", "marker-1", { body: "Check edge" });
      const task = await linkAiReviewMarkerReviewTask("proj-1", "marker-1", { assignee: "reviewer-a" });

      expect(listed.markers).toHaveLength(1);
      expect(created.marker.status).toBe("processing");
      expect(updated.marker.status).toBe("accepted");
      expect(comment.marker.linkedCommentIds).toContain("comment-1");
      expect(task.marker.linkedTaskIds).toContain("task-1");
      expect(mockFetch.mock.calls[0][0]).toContain("/project/proj-1/ai-markers");
      expect(mockFetch.mock.calls[1][1]?.method).toBe("POST");
      expect(mockFetch.mock.calls[2][1]?.method).toBe("PATCH");
      expect(JSON.parse(mockFetch.mock.calls[2][1]?.body as string)).toMatchObject({
        linkedCommentIds: ["comment-1"],
        linkedTaskIds: ["task-1"],
      });
      expect(mockFetch.mock.calls[3][0]).toContain("/project/proj-1/ai-markers/marker-1/comments");
      expect(mockFetch.mock.calls[4][0]).toContain("/project/proj-1/ai-markers/marker-1/review-task");
    });
  });

  describe("getAdminConfig", () => {
    it("returns masked config", async () => {
      const { getAdminConfig } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          openrouterEnabled: false,
          openrouterApiKey: "••••••••",
          chatgptEnabled: true,
          primaryBackend: "chatgpt",
        }), { status: 200 })
      );

      const result = await getAdminConfig();
      expect(result.chatgptEnabled).toBe(true);
      expect(result.openrouterApiKey).toBe("••••••••");
    });
  });

  describe("updateAdminConfig", () => {
    it("sends partial config update", async () => {
      const { updateAdminConfig } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

      const update = { openrouterEnabled: true };
      const result = await updateAdminConfig(update);

      expect(result.ok).toBe(true);

      const call = mockFetch.mock.calls[0];
      expect(call[1]?.method).toBe("POST");
      const body = JSON.parse(call[1]?.body);
      expect(body.openrouterEnabled).toBe(true);
    });
  });

  describe("error handling", () => {
    it("handles network errors gracefully", async () => {
      const { createProject } = await import("../api/client.js");

      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(createProject("Test", "th")).rejects.toThrow("Network error");
    });

    it("handles server errors with status codes", async () => {
      const { createProject } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Validation failed" }), { status: 400 })
      );

      await expect(createProject("Test", "th")).rejects.toThrow("Validation failed");
    });

    it("handles 500 errors", async () => {
      const { createProject } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 })
      );

      await expect(createProject("Test", "th")).rejects.toThrow("Internal server error");
    });

    it("formats rate limit errors with retry metadata", async () => {
      const { createProject, ApiError } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "Too many requests",
          code: "rate_limit_exceeded",
          retryAfter: 45,
        }), {
          status: 429,
          headers: { "Retry-After": "45" },
        })
      );

      let caught: unknown;
      try {
        await createProject("Test", "th");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as InstanceType<typeof ApiError>).message).toBe("ส่งคำขอถี่เกินไป. ลองอีกครั้งใน 45 วินาที");
      expect((caught as InstanceType<typeof ApiError>).status).toBe(429);
      expect((caught as InstanceType<typeof ApiError>).code).toBe("rate_limit_exceeded");
      expect((caught as InstanceType<typeof ApiError>).retryAfter).toBe(45);
    });

    it("formats AI queue admission errors as actionable messages", async () => {
      const { submitAiJob } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "AI queue capacity exceeded",
          code: "ai_queue_capacity_exceeded",
          reason: "project_pending_limit",
          retryAfter: 30,
        }), { status: 429 })
      );

      await expect(submitAiJob({
        projectId: "proj-1",
        imageId: "img1.png",
        crop: { x: 0, y: 0, w: 100, h: 100 },
        lang: "th",
        tier: "sfx-pro",
      })).rejects.toThrow("คิว AI แน่น: ของโปรเจกต์นี้. ลองอีกครั้งใน 30 วินาที");
    });

    it("formats storage quota errors without leaking raw backend wording", async () => {
      const { uploadImages } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "Storage quota exceeded",
          code: "storage_quota_exceeded",
        }), { status: 413 })
      );

      await expect(uploadImages("proj-1", [new File(["x"], "a.png", { type: "image/png" })]))
        .rejects.toThrow("Storage ของเวิร์กสเปซเต็ม. ลบไฟล์หรือเพิ่ม storage ก่อนอัปโหลดต่อ.");
    });

    it("localizes image_dimensions_too_small (422) with the backend min dimensions", async () => {
      const { uploadImages } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "Uploaded image is below the minimum accepted dimensions",
          code: "image_dimensions_too_small",
          filename: "tiny.png",
          width: 40,
          height: 40,
          minWidth: 64,
          minHeight: 64,
        }), { status: 422 })
      );

      // Active locale in tests is the default (th); the message must NOT leak the
      // raw English backend string, and must echo the 64px minimum.
      await expect(uploadImages("proj-1", [new File(["x"], "tiny.png", { type: "image/png" })]))
        .rejects.toThrow(/64×64 px/);
    });

    it("localizes image_not_decodable (422) without leaking raw backend wording", async () => {
      const { uploadImages } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "Uploaded image is not decodable",
          code: "image_not_decodable",
          filename: "broken.png",
        }), { status: 422 })
      );

      await expect(uploadImages("proj-1", [new File(["x"], "broken.png", { type: "image/png" })]))
        .rejects.not.toThrow("Uploaded image is not decodable");
    });

    it("localizes chapter_image_limit_exceeded (413) with the chapter image cap", async () => {
      const { uploadImages } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "Chapter image limit exceeded",
          code: "chapter_image_limit_exceeded",
          reason: "max_images_per_chapter",
          limitImages: 300,
        }), { status: 413 })
      );

      await expect(uploadImages("proj-1", [new File(["x"], "a.png", { type: "image/png" })]))
        .rejects.toThrow(/300/);
    });

    it("maps the upload_batch_size_exceeded code to friendly oversize guidance", async () => {
      const { uploadImages } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "Upload batch size limit exceeded",
          code: "upload_batch_size_exceeded",
          reason: "max_upload_batch_size",
        }), { status: 413 })
      );

      await expect(uploadImages("proj-1", [new File(["x"], "a.png", { type: "image/png" })]))
        .rejects.toThrow("ไฟล์รวมกันใหญ่เกินไป — อัปโหลดทีละน้อยลง หรือย่อขนาด/บีบอัดรูปก่อน แล้วลองอีกครั้ง");
    });

    it("maps a raw per-file 413 (no code) to friendly oversize guidance", async () => {
      const { uploadImages } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "File big.png exceeds 50MB limit",
        }), { status: 413 })
      );

      await expect(uploadImages("proj-1", [new File(["x"], "big.png", { type: "image/png" })]))
        .rejects.toThrow("ไฟล์รวมกันใหญ่เกินไป — อัปโหลดทีละน้อยลง หรือย่อขนาด/บีบอัดรูปก่อน แล้วลองอีกครั้ง");
    });

    // The store + ChapterSetupDialog short-circuit on isUploadTooLargeError() BEFORE
    // falling back to error.message, so this predicate must NOT claim a coded quota
    // 413 (storage_quota_exceeded) — otherwise that error wrongly shows the generic
    // oversize-upload guidance instead of its own "Storage เต็ม..." message.
    it("isUploadTooLargeError: excludes a coded storage_quota_exceeded 413", async () => {
      const { isUploadTooLargeError, ApiError } = await import("../api/client.js");
      const err = new ApiError("Storage ของเวิร์กสเปซเต็ม. ลบไฟล์หรือเพิ่ม storage ก่อนอัปโหลดต่อ.", {
        status: 413,
        statusText: "Payload Too Large",
        code: "storage_quota_exceeded",
      });
      expect(isUploadTooLargeError(err)).toBe(false);
    });

    it("isUploadTooLargeError: claims a coded upload_batch_size_exceeded 413", async () => {
      const { isUploadTooLargeError, ApiError } = await import("../api/client.js");
      const err = new ApiError("oversize", {
        status: 413,
        statusText: "Payload Too Large",
        code: "upload_batch_size_exceeded",
      });
      expect(isUploadTooLargeError(err)).toBe(true);
    });

    it("isUploadTooLargeError: claims a bare 413 with no code", async () => {
      const { isUploadTooLargeError, ApiError } = await import("../api/client.js");
      const err = new ApiError("File big.png exceeds 50MB limit", {
        status: 413,
        statusText: "Payload Too Large",
      });
      expect(isUploadTooLargeError(err)).toBe(true);
    });

    it("formats plan usage quota errors by quota class", async () => {
      const { submitAiJob } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "Workspace usage quota exceeded",
          code: "usage_quota_exceeded",
          reason: "daily_ai_credit_limit",
        }), { status: 402 })
      );

      await expect(submitAiJob({
        projectId: "proj-1",
        imageId: "img1.png",
        crop: { x: 0, y: 0, w: 100, h: 100 },
        lang: "th",
        tier: "sfx-pro",
      })).rejects.toThrow("โควตาแผนเวิร์กสเปซเต็ม: ของเครดิต AI วันนี้. อัปเกรดแผนหรือรอรอบโควตารีเซ็ต.");
    });

    it("formats export quota errors by quota class", async () => {
      const { recordExportUsage } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "Workspace usage quota exceeded",
          code: "usage_quota_exceeded",
          reason: "monthly_export_bytes_limit",
        }), { status: 402 })
      );

      await expect(recordExportUsage("proj-1", {
        bytes: 1234,
        filename: "chapter.zip",
        exportKind: "batch-zip",
      })).rejects.toThrow("โควตาแผนเวิร์กสเปซเต็ม: ของปริมาณ Export เดือนนี้. อัปเกรดแผนหรือรอรอบโควตารีเซ็ต.");
    });
  });

  describe("text QA", () => {
    it("posts text and lang to the text-qa check endpoint", async () => {
      const { checkTextQa } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          issues: [{ start: 0, end: 4, type: "typo", message: "สะกดผิด", suggestion: "สวัสดี" }],
          cached: false,
          model: "gpt-4o-mini",
          lang: "th",
          quota: { usedChars: 4, limitChars: 50000, remainingChars: 49996, resetAt: Date.now() + 1000, planId: "free" },
        }), { status: 200 })
      );

      const result = await checkTextQa("สวัสดร", "th");
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe("typo");
      expect(result.cached).toBe(false);
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toContain("/text-qa/check");
      expect(call[1]?.method).toBe("POST");
      expect(JSON.parse(call[1]?.body)).toEqual({ text: "สวัสดร", lang: "th" });
    });

    it("forwards projectId so the check bills the project's workspace plan", async () => {
      const { checkTextQa } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          issues: [],
          cached: false,
          model: "gpt-4o-mini",
          lang: "th",
          quota: { usedChars: 4, limitChars: 200000, remainingChars: 199996, resetAt: Date.now() + 1000, planId: "pro" },
        }), { status: 200 })
      );

      await checkTextQa("สวัสดร", "th", { projectId: "proj-1" });
      const call = mockFetch.mock.calls[0];
      expect(JSON.parse(call[1]?.body)).toEqual({ text: "สวัสดร", lang: "th", projectId: "proj-1" });
    });

    it("surfaces the text-qa daily quota error", async () => {
      const { checkTextQa, ApiError } = await import("../api/client.js");

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "Daily text-QA character budget exceeded",
          code: "text_qa_quota_exceeded",
          quota: { usedChars: 50000, limitChars: 50000, remainingChars: 0, resetAt: Date.now() + 1000, planId: "free" },
        }), { status: 402 })
      );

      try {
        await checkTextQa("more text", "en");
        throw new Error("expected quota error");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as InstanceType<typeof ApiError>).code).toBe("text_qa_quota_exceeded");
        expect((error as InstanceType<typeof ApiError>).status).toBe(402);
      }
    });
  });

  describe("authed image loading (editor + export)", () => {
    it("classifies backend asset URLs but not data:/blob:", async () => {
      const { isApiAssetUrl } = await import("../api/client.js");
      expect(isApiAssetUrl("/api/images/proj-1/img-1")).toBe(true);
      expect(isApiAssetUrl("data:image/png;base64,AAAA")).toBe(false);
      expect(isApiAssetUrl("blob:http://localhost/abc")).toBe(false);
      expect(isApiAssetUrl("")).toBe(false);
    });

    it("fetches backend assets with the access token and revokes the object URL after Fabric load", async () => {
      const { loadAuthedFabricImage, setApiAccessToken } = await import("../api/client.js");
      setApiAccessToken("access-token");

      const createObjectURL = vi.fn(() => "blob:authed-object-url");
      const revokeObjectURL = vi.fn();
      const originalCreate = (URL as any).createObjectURL;
      const originalRevoke = (URL as any).revokeObjectURL;
      (URL as any).createObjectURL = createObjectURL;
      (URL as any).revokeObjectURL = revokeObjectURL;

      mockFetch.mockResolvedValueOnce(
        new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), { status: 200 })
      );

      let loadedUrl = "";
      const fabric = {
        FabricImage: {
          fromURL: async (url: string) => {
            loadedUrl = url;
            return { width: 4, height: 4 } as unknown;
          },
        },
      };

      try {
        const img = await loadAuthedFabricImage(fabric, "/api/images/proj-1/img-1") as any;
        expect(img.width).toBe(4);
        // Fabric received the same-origin blob URL, not the raw API URL.
        expect(loadedUrl).toBe("blob:authed-object-url");
        // Auth header was attached to the asset fetch.
        const headers = mockFetch.mock.calls[0][1]?.headers as Headers;
        expect(headers.get("Authorization")).toBe("Bearer access-token");
        // Object URL revoked after load (no leak).
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:authed-object-url");
      } finally {
        (URL as any).createObjectURL = originalCreate;
        (URL as any).revokeObjectURL = originalRevoke;
      }
    });

    it("passes data:/blob: URLs straight to Fabric without fetching", async () => {
      const { loadAuthedFabricImage } = await import("../api/client.js");
      let loadedUrl = "";
      const fabric = {
        FabricImage: {
          fromURL: async (url: string) => {
            loadedUrl = url;
            return { width: 1, height: 1 } as unknown;
          },
        },
      };
      await loadAuthedFabricImage(fabric, "blob:http://localhost/fresh-upload");
      expect(loadedUrl).toBe("blob:http://localhost/fresh-upload");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    // codex P1-A: the client export must fetch assets THROUGH the server export
    // serve-gate (export-purpose signed token). A non-`passed` asset (needs_review /
    // quarantined / blocked / no passing record) cannot mint an export token, so the
    // export loader FAILS CLOSED — it never falls back to the editor_preview (Bearer)
    // load, so the asset bytes can never enter a client-built ZIP / single-page render.
    describe("loadExportFabricImage (server export-gate enforcement, codex P1-A)", () => {
      beforeEach(async () => {
        const { __clearAssetTokenCacheForTests } = await import("../api/client.js");
        __clearAssetTokenCacheForTests();
      });

      it("mints an EXPORT-purpose token and fetches the asset through the export gate", async () => {
        const { loadExportFabricImage, setApiAccessToken } = await import("../api/client.js");
        const { config } = await import("$lib/config.js");
        setApiAccessToken("access-token");

        const createObjectURL = vi.fn(() => "blob:export-object-url");
        const revokeObjectURL = vi.fn();
        const originalCreate = (URL as any).createObjectURL;
        const originalRevoke = (URL as any).revokeObjectURL;
        (URL as any).createObjectURL = createObjectURL;
        (URL as any).revokeObjectURL = revokeObjectURL;

        // 1st fetch = export-purpose token mint (server only mints for a `passed` asset);
        // 2nd fetch = the actual byte fetch carrying ?assetToken= (the export-gated read).
        mockFetch
          .mockResolvedValueOnce(new Response(JSON.stringify({
            token: "export-tok",
            purpose: "export",
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
          }), { status: 200, headers: { "Content-Type": "application/json" } }))
          .mockResolvedValueOnce(new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), { status: 200 }));

        let loadedUrl = "";
        const fabric = {
          FabricImage: { fromURL: async (url: string) => { loadedUrl = url; return { width: 4, height: 4 } as unknown; } },
        };

        try {
          const img = await loadExportFabricImage(
            fabric, "proj-1", "img-1.png", `${config.apiBase}/images/proj-1/img-1.png`,
          ) as any;
          expect(img.width).toBe(4);
          expect(loadedUrl).toBe("blob:export-object-url");
          // The token mint requested the EXPORT purpose (the strict server bar).
          expect(mockFetch.mock.calls[0][0] as string).toBe(
            `${config.apiBase}/images/proj-1/img-1.png/access-token?purpose=export`,
          );
          // The byte fetch carried the export token (gated read).
          expect(mockFetch.mock.calls[1][0] as string).toContain("assetToken=export-tok");
          expect(revokeObjectURL).toHaveBeenCalledWith("blob:export-object-url");
        } finally {
          (URL as any).createObjectURL = originalCreate;
          (URL as any).revokeObjectURL = originalRevoke;
        }
      });

      it("FAILS CLOSED when the export token can't be minted (non-passed asset) and never fetches bytes", async () => {
        const { loadExportFabricImage, ExportAssetNotAuthorizedError, setApiAccessToken } = await import("../api/client.js");
        const { config } = await import("$lib/config.js");
        setApiAccessToken("access-token");

        // The server denies an export token for a needs_review/quarantined/blocked asset.
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "Asset is not available for export", code: "asset_not_exportable" }), { status: 403 }),
        );

        let fabricCalled = false;
        const fabric = { FabricImage: { fromURL: async () => { fabricCalled = true; return {} as unknown; } } };

        await expect(
          loadExportFabricImage(fabric, "proj-1", "img-1.png", `${config.apiBase}/images/proj-1/img-1.png`),
        ).rejects.toBeInstanceOf(ExportAssetNotAuthorizedError);

        // Only the (failed) token mint ran — the byte fetch (and the editor_preview
        // Bearer fallback) must NOT have happened, so no asset entered the export.
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0] as string).toContain("access-token?purpose=export");
        expect(fabricCalled).toBe(false);
      });

      it("passes data:/blob: previews straight through (no server asset to gate)", async () => {
        const { loadExportFabricImage } = await import("../api/client.js");
        let loadedUrl = "";
        const fabric = { FabricImage: { fromURL: async (url: string) => { loadedUrl = url; return { width: 1, height: 1 } as unknown; } } };
        await loadExportFabricImage(fabric, "proj-1", "img-1.png", "data:image/png;base64,AAAA");
        expect(loadedUrl).toBe("data:image/png;base64,AAAA");
        expect(mockFetch).not.toHaveBeenCalled();
      });
    });
  });

  // Transparent access-token refresh on 401. When a request 401s (the short-TTL
  // access token expired), the client runs ONE refresh via the registered
  // handler and retries the original request once with the new token. These
  // tests pin down the four invariants: refresh+retry succeeds, concurrent 401s
  // share ONE refresh, a failed refresh clears the session without looping, and
  // the /auth/* routes never trigger a refresh (no infinite loop).
  describe("refresh on 401", () => {
    afterEach(async () => {
      const { __resetAuthRefreshForTests } = await import("../api/client.js");
      __resetAuthRefreshForTests();
    });

    it("(a) 401 → single refresh → retries the original request and succeeds", async () => {
      const { listProjects, setApiAccessToken, setAuthRefreshHandler } = await import("../api/client.js");

      setApiAccessToken("stale-token");
      let refreshCalls = 0;
      setAuthRefreshHandler(async () => {
        refreshCalls += 1;
        // Simulate the auth store rotating + applying the new access token.
        setApiAccessToken("fresh-token");
        return "fresh-token";
      });

      mockFetch
        // First attempt: access token expired → 401.
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "expired" }), { status: 401 }))
        // Retry after refresh: succeeds.
        .mockResolvedValueOnce(new Response(JSON.stringify({ projects: [{ projectId: "p-1", name: "Ch 1", createdAt: "", updatedAt: "", targetLang: "th", pageCount: 0, textLayerCount: 0 }] }), { status: 200 }));

      const result = await listProjects();

      expect(result.projects).toHaveLength(1);
      expect(refreshCalls).toBe(1);
      // Two network calls: the 401 and the post-refresh retry.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // The retry carried the freshly-minted token, not the stale one.
      const retryHeaders = mockFetch.mock.calls[1][1]?.headers as Headers;
      expect(retryHeaders.get("Authorization")).toBe("Bearer fresh-token");
    });

    it("(b) concurrent 401s share a SINGLE refresh (no refresh storm)", async () => {
      const { listProjects, setApiAccessToken, setAuthRefreshHandler } = await import("../api/client.js");

      setApiAccessToken("stale-token");
      let refreshCalls = 0;
      // Refresh hangs until we release it, so all three requests' 401s queue on
      // the same in-flight refresh before any of them retries.
      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      setAuthRefreshHandler(async () => {
        refreshCalls += 1;
        await refreshGate;
        setApiAccessToken("fresh-token");
        return "fresh-token";
      });

      const ok = () => new Response(JSON.stringify({ projects: [] }), { status: 200 });
      mockFetch.mockImplementation((_url: any, init: any) => {
        // Stale token → 401; fresh token → 200.
        const headers = init?.headers as Headers;
        return Promise.resolve(headers?.get("Authorization") === "Bearer fresh-token"
          ? ok()
          : new Response(JSON.stringify({ error: "expired" }), { status: 401 }));
      });

      const pending = Promise.all([listProjects(), listProjects(), listProjects()]);
      // Let the three initial 401s resolve and register on the shared refresh.
      await new Promise((r) => setTimeout(r, 0));
      releaseRefresh();
      const results = await pending;

      expect(results).toHaveLength(3);
      // Exactly ONE refresh shared by all three concurrent 401s.
      expect(refreshCalls).toBe(1);
      // 3 initial 401s + 3 retries = 6 fetches, but only 1 refresh.
      expect(mockFetch).toHaveBeenCalledTimes(6);
    });

    it("(b2) staggered 401s sent under the same stale token still share ONE refresh", async () => {
      // The harder real-world case the browser surfaced: several requests are
      // sent BEFORE any refresh, all carrying the same stale token, so the
      // server 401s each. Their 401 responses arrive at staggered times — some
      // AFTER the first request's refresh already resolved. The refresh-epoch
      // guard must make those late 401s retry with the already-fresh token
      // instead of each kicking off a brand-new refresh.
      const { listProjects, setApiAccessToken, setAuthRefreshHandler } = await import("../api/client.js");

      setApiAccessToken("stale-token");
      let refreshCalls = 0;
      setAuthRefreshHandler(async () => {
        refreshCalls += 1;
        setApiAccessToken("fresh-token");
        return "fresh-token";
      });

      // Make each request's first (stale-token) attempt resolve on a staggered
      // delay so the refresh from the earliest 401 completes before later 401s
      // land. Fresh-token requests succeed immediately.
      let staleAttempt = 0;
      mockFetch.mockImplementation((_url: any, init: any) => {
        const headers = init?.headers as Headers;
        if (headers?.get("Authorization") === "Bearer fresh-token") {
          return Promise.resolve(new Response(JSON.stringify({ projects: [] }), { status: 200 }));
        }
        // Stagger the 401s: 0ms, 10ms, 20ms, ... so they arrive well after the
        // first refresh resolves.
        const delay = staleAttempt++ * 10;
        return new Promise((resolve) =>
          setTimeout(() => resolve(new Response(JSON.stringify({ error: "expired" }), { status: 401 })), delay),
        );
      });

      const results = await Promise.all([
        listProjects(),
        listProjects(),
        listProjects(),
        listProjects(),
      ]);

      expect(results).toHaveLength(4);
      // The crux: despite staggered 401s, exactly ONE refresh — not four.
      expect(refreshCalls).toBe(1);
    });

    it("(c) refresh failure clears the session and does NOT loop", async () => {
      const { listProjects, setApiAccessToken, setAuthRefreshHandler, ApiError } = await import("../api/client.js");

      setApiAccessToken("stale-token");
      let cleared = false;
      let refreshCalls = 0;
      setAuthRefreshHandler(async () => {
        refreshCalls += 1;
        // Refresh token invalid/expired → handler clears session, returns null.
        cleared = true;
        return null;
      });

      // Every call 401s; if the client looped it would keep refetching forever.
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: "expired" }), { status: 401 }));

      await expect(listProjects()).rejects.toBeInstanceOf(ApiError);
      expect(cleared).toBe(true);
      expect(refreshCalls).toBe(1);
      // ONE original request + ONE refresh attempt that failed → NO retry.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("(d) a 401 from the /auth/refresh route is NOT retried (no infinite loop)", async () => {
      const { refreshAuthSession, setAuthRefreshHandler } = await import("../api/client.js");

      let refreshCalls = 0;
      // A handler IS registered, to prove the auth-route guard — not a missing
      // handler — is what prevents the loop.
      setAuthRefreshHandler(async () => {
        refreshCalls += 1;
        return "should-not-be-used";
      });

      mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: "invalid refresh token" }), { status: 401 }));

      await expect(refreshAuthSession("bad-refresh")).rejects.toBeInstanceOf(Error);
      // The /auth/refresh request 401'd but was NOT retried, and the refresh
      // handler was NEVER invoked from inside the client.
      expect(refreshCalls).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("does not attempt refresh when no handler is registered", async () => {
      const { listProjects, setApiAccessToken, ApiError } = await import("../api/client.js");

      setApiAccessToken("stale-token");
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: "expired" }), { status: 401 }));

      await expect(listProjects()).rejects.toBeInstanceOf(ApiError);
      // No handler → original 401 surfaces with a single network call.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("server-owned mutation CAS baseline", () => {
    function jsonResponse(body: unknown, init: { status?: number; stateHash?: string } = {}): Response {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (init.stateHash) headers["x-project-state-hash"] = init.stateHash;
      return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
    }

    function baseHashHeader(call: unknown[]): string | undefined {
      const headers = call[1] && (call[1] as RequestInit).headers;
      if (!headers) return undefined;
      if (headers instanceof Headers) return headers.get("X-Project-Base-State-Hash") ?? undefined;
      const rec = headers as Record<string, string>;
      return rec["X-Project-Base-State-Hash"] ?? rec["x-project-base-state-hash"];
    }

    it("sends the captured baseline hash header on a dedicated mutation after loadProject", async () => {
      const { loadProject, updateProjectTask, clearProjectStateBaseHash } = await import("../api/client.js");
      const projectId = `cas-${Math.random().toString(36).slice(2)}`;
      clearProjectStateBaseHash(projectId);

      // GET stamps the current full-state hash → cached as the CAS baseline.
      mockFetch.mockResolvedValueOnce(jsonResponse({ projectId, pages: [] }, { stateHash: "hash-A" }));
      await loadProject(projectId);

      // The next dedicated mutation echoes that baseline back to the server.
      mockFetch.mockResolvedValueOnce(jsonResponse({ task: { id: "t1" }, activityLog: [] }, { stateHash: "hash-B" }));
      await updateProjectTask(projectId, "t1", { status: "doing" });

      const mutationCall = mockFetch.mock.calls[1];
      expect(String(mutationCall[0])).toContain(`/project/${projectId}/tasks/t1`);
      expect(baseHashHeader(mutationCall)).toBe("hash-A");
    });

    it("on a 409 project_save_conflict, refetches the project and retries the mutation once with the refreshed baseline", async () => {
      const { loadProject, createProjectComment, clearProjectStateBaseHash } = await import("../api/client.js");
      const projectId = `cas-${Math.random().toString(36).slice(2)}`;
      clearProjectStateBaseHash(projectId);

      mockFetch.mockResolvedValueOnce(jsonResponse({ projectId, pages: [] }, { stateHash: "hash-A" }));
      await loadProject(projectId);

      // 1st mutation (baseline hash-A) → 409 conflict.
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "Project changed remotely", code: "project_save_conflict" }, { status: 409 }));
      // The client refetches the project → new baseline hash-C.
      mockFetch.mockResolvedValueOnce(jsonResponse({ projectId, pages: [] }, { stateHash: "hash-C" }));
      // Retry succeeds.
      mockFetch.mockResolvedValueOnce(jsonResponse({ comment: { id: "c1" }, comments: [], activityLog: [] }, { stateHash: "hash-D" }));

      const result = await createProjectComment(projectId, { pageIndex: 0, body: "hi" } as never);
      expect((result as { comment: { id: string } }).comment.id).toBe("c1");

      // Calls: loadProject(GET) + mutation(409) + refetch(GET) + retry(mutation) = 4.
      expect(mockFetch).toHaveBeenCalledTimes(4);
      // First mutation carried the stale baseline; the retry carried the refreshed one.
      expect(baseHashHeader(mockFetch.mock.calls[1])).toBe("hash-A");
      expect(String(mockFetch.mock.calls[2][0])).toContain(`/project/${projectId}`);
      expect(baseHashHeader(mockFetch.mock.calls[3])).toBe("hash-C");
    });

    it("a first-touch mutation with no cached baseline sends no header (back-compat single-writer)", async () => {
      const { createProjectComment, clearProjectStateBaseHash } = await import("../api/client.js");
      const projectId = `cas-${Math.random().toString(36).slice(2)}`;
      clearProjectStateBaseHash(projectId);

      mockFetch.mockResolvedValueOnce(jsonResponse({ comment: { id: "c1" }, comments: [], activityLog: [] }, { stateHash: "hash-X" }));
      await createProjectComment(projectId, { pageIndex: 0, body: "first" } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(baseHashHeader(mockFetch.mock.calls[0])).toBeUndefined();
    });
  });

  describe("chapter team + contacts", () => {
    function okJson(body: unknown, status = 200): Response {
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }

    it("createProject forwards productionMode + initialInvites", async () => {
      const { createProject } = await import("../api/client.js");
      mockFetch.mockResolvedValueOnce(okJson({ projectId: "p1" }));
      await createProject("Ch1", "th", {
        productionMode: "team",
        initialInvites: [{ email: "a@b.com", role: "translator" }],
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.productionMode).toBe("team");
      expect(body.initialInvites).toEqual([{ email: "a@b.com", role: "translator" }]);
    });

    it("getChapterTeam reads the team endpoint", async () => {
      const { getChapterTeam } = await import("../api/client.js");
      mockFetch.mockResolvedValueOnce(okJson({ productionMode: "team", team: [], maxMembers: 100 }));
      const view = await getChapterTeam("p1");
      expect(String(mockFetch.mock.calls[0][0])).toContain("/project/p1/team");
      expect(view.productionMode).toBe("team");
    });

    it("inviteChapterTeamMember POSTs the invite by UID", async () => {
      const { inviteChapterTeamMember } = await import("../api/client.js");
      mockFetch.mockResolvedValueOnce(okJson({ member: { id: "m1", role: "qc", status: "active" }, productionMode: "team" }, 201));
      const res = await inviteChapterTeamMember("p1", { userId: "u9", role: "qc" });
      expect(String(mockFetch.mock.calls[0][0])).toContain("/project/p1/team/invites");
      expect(JSON.parse(mockFetch.mock.calls[0][1].body as string)).toEqual({ userId: "u9", role: "qc" });
      expect(res.member.id).toBe("m1");
    });

    it("removeChapterTeamMember DELETEs the member", async () => {
      const { removeChapterTeamMember } = await import("../api/client.js");
      mockFetch.mockResolvedValueOnce(okJson({ ok: true, productionMode: "solo" }));
      await removeChapterTeamMember("p1", "m1");
      expect(mockFetch.mock.calls[0][1].method).toBe("DELETE");
      expect(String(mockFetch.mock.calls[0][0])).toContain("/project/p1/team/m1");
    });

    it("addContact POSTs to /contacts", async () => {
      const { addContact } = await import("../api/client.js");
      mockFetch.mockResolvedValueOnce(okJson({ contact: { id: "c1", relationship: "friend" } }, 201));
      await addContact({ email: "x@y.com", suggestedRole: "cleaner" });
      expect(String(mockFetch.mock.calls[0][0])).toContain("/contacts");
      expect(JSON.parse(mockFetch.mock.calls[0][1].body as string).suggestedRole).toBe("cleaner");
    });
  });
});
