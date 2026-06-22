# Wave 5 — End-to-end customer-journey smoke

A single, opt-in smoke that walks the whole SaaS customer journey against the
**real backend** (the actual Hono app, booted in-process in file-mode — no
Postgres/Redis/external creds required):

```
signup → verify-email → create-workspace → invite-member → upload-chapter →
translate (AI) → typeset → QC → export → subscribe/pay
```

## Run it

```bash
# From the repo root
bun run test:e2e
# or
RUN_E2E_SMOKE=1 bun run tests/e2e/customer-journey.smoke.ts
```

The script **does nothing unless `RUN_E2E_SMOKE=1` is set** (exits 0 with a skip
message), so it can be invoked safely from any script without side effects.

## CI safety (additive + opt-in)

This file lives at the repo root under `tests/e2e/`, deliberately **outside every
existing CI test glob**:

- Backend CI runs `bun test backend/src/__tests__/` — does not reach `tests/e2e/`.
- Frontend CI runs `bun run build` + `vitest` — does not run this file.
- The frontend Playwright suite (`frontend/e2e/*.spec.ts`) is browser-driven and
  is not invoked by CI; this smoke is a separate Bun script, not a `.spec.ts`.

So the smoke is purely additive and never runs in the existing CI jobs.

## What is REAL vs STUBBED

| Step | Endpoint | Classification | Notes / real cred needed |
|------|----------|----------------|--------------------------|
| signup | `POST /api/auth/register` | **REAL** | — |
| verify-email | `POST /api/auth/verify-email` | **REAL** | Token is captured from an **injected test mailer** — only the email *delivery provider* is stubbed; the verify token + endpoint are exercised for real. Real delivery needs `MAILER_PROVIDER=resend` + `RESEND_API_KEY`. |
| login | `POST /api/auth/login` | **REAL** | — |
| create-workspace | `POST /api/workspaces` | **POSTGRES-GATED** | File-mode returns `503 workspace_store_unavailable` (the documented contract). Becomes **REAL** with `DATABASE_URL` set. |
| invite-member | `POST /api/workspaces/:id/invites` | **POSTGRES-GATED** | File-mode: `503 workspace_store_unavailable`. With `DATABASE_URL`, when create-workspace returned `201` the caller is seeded as owner, so the invite **must** return `201` — a 403/404/503 there is treated as a regression and fails the smoke (no false pass). |
| create-chapter | `POST /api/project/new` | **REAL** | Personal project = the file-mode chapter surface. |
| upload-chapter | `POST /api/images/:id/upload` | **REAL** | Real PNG, multipart, asset registry + storage. |
| translate (AI) | `POST /api/ai/translate` | **STUBBED** | The OpenAI HTTPS boundary (`api.openai.com`, incl. `/v1/moderations`) is intercepted via `globalThis.fetch`; no real key/cost. The endpoint contract is asserted: the smoke passes **only** when the job is queued (2xx + job handle) **or** the request hits a *documented* provider/asset/credit/queue gate (specific status + `code`/`reason`). A 400 validation, 401/403 auth/access, or any other error fails the smoke. Real AI needs `OPENAI_API_KEY` + `OPENAI_IMAGES_ENABLED=true` + a ready asset. |
| typeset | `POST /api/project/:id/save` | **REAL** | Registers the uploaded image as a page and places the translated text as a text layer — the real persisted artifact a typesetter produces. |
| QC | `POST /api/project/:id/review-decisions` | **REAL** | Approves page 0 (real review decision + workflow task update). |
| export | `POST /api/export` | **REAL** | Enqueues a real export job (`202`) using the build's first advertised preset. |
| subscribe / pay | `POST /api/billing/:id/checkout-session` | **MOUNTED (mock provider)** | Sent through the in-process `app`, so it covers real route ordering (mock `billing` mounted before `billingDodo`) + provider fall-through. Default provider is `mock`: file-mode returns `503 workspace_store_unavailable` (no workspace store); with `DATABASE_URL` + an owned workspace it returns `200` with a labeled prototype `checkout_url` + `provider:"mock"`. Real Dodo needs `BILLING_PROVIDER=dodo` + `DODO_API_KEY` + `DATABASE_URL`. |

### Summary of external creds a fully-real run would need

- `DATABASE_URL` — Postgres: lights up create-workspace, invite-member, work-state
  transitions, and billing persistence.
- `OPENAI_API_KEY` (+ `OPENAI_IMAGES_ENABLED=true`) — real AI translate/clean.
- `BILLING_PROVIDER=dodo` + `DODO_API_KEY` (+ webhook secret) — real Dodo checkout/pay.
- `MAILER_PROVIDER=resend` + `RESEND_API_KEY` — real verification-email delivery.

When `DATABASE_URL` is present the workspace/invite steps automatically take the
REAL path (the script records which path each step took), so a Postgres-backed
run upgrades coverage without any code change.
