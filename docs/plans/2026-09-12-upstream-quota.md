# Upstream upgrade and Viewer Portal quota implementation plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Incorporate upstream 0.5.75 first, then publish admin-selected global account quotas behind the existing viewer password without expanding upstream-owned runtime integration points.

**Architecture:** Merge the pinned upstream master snapshot `17c4cc76877bd1755030a8414f8d0083f48dcccf` (0.5.75 plus two upstream commits, satisfying the managed updater's ancestry check). Preserve managed image safety while incorporating upstream's runtime dependency fix. Quota configuration, adapter, APIs and UI live exclusively in existing fork-owned portal paths. Usage attribution and groups do not affect quotas.

**Tech Stack:** Existing Next.js/React JavaScript, SQLite settings namespace, Vitest, Python unittest; no new dependencies.

## Agreed design

- Viewer has separate Usage and Quota views, both requiring the same viewer session.
- All authenticated viewers see identical global account quota cards. No allocation or groups.
- Admin has a dedicated Quota tab selecting existing accounts, with optional public labels.
- Publish only sanitized quota metrics/reset times; exclude secrets, private account identity and raw upstream errors.
- Reuse upstream quota retrieval behind one portal adapter; do not alter provider quota logic or upstream DB schema.
- Mount quota reads below `/api/viewer-portal/usage/quota`, the existing guarded viewer usage namespace, avoiding another upstream dashboardGuard edit.
- Unknown quota remains unknown. Cache/coalesce requests, authenticate before cache access, and bound provider work.
- No deployment or production mutations.

## Task 1: Upgrade (separate merge commit)

Files: `Dockerfile`, fork-owned `package-lock.json`, `UPSTREAM.md`.
1. Merge upstream snapshot, keep pinned base/npm ci/non-root managed image, add upstream node-machine-id runtime copy.
2. Synchronize lockfile package version without changing upstream manifest.
3. Run fork tests, operations checks and representative upstream auth/stream/quota tests. Record failures separately rather than rebaseline blindly.
4. Build using isolated DATA_DIR/HOME; update upstream baseline and integration documentation; commit merge.

## Task 2: Quota backend (test first)

Files: `src/lib/viewerPortal/{config,quota}.js`, `src/app/api/viewer-portal/admin/quota/route.js`, `src/app/api/viewer-portal/usage/quota/route.js`, `tests/unit/viewer-portal-quota*.test.js`.
1. Add failing tests for configuration validation, allowlisted projection, private/deleted accounts, cached auth, error isolation and upstream call contract.
2. Add `quotaAccounts` under fork settings; invalid submissions fail without changing existing publication.
3. Use one upstream quota adapter with shared bounded cache; fetch only published accounts, no viewer-selected connection IDs or force-refresh.
4. Admin route lists sanitized accounts and saves validated selection. Viewer route authenticates before retrieval and returns no-store.
5. Run focused tests until green.

## Task 3: Quota UI

Files: existing fork-owned ViewerPortalAdmin.js and PortalPageClient.js, new colocated quota components if needed.
1. Admin Quota tab selects accounts and edits public label, persists independently of Usage groups.
2. Viewer Usage/Quota navigation shares global password, including quota-only setup (no usage groups).
3. Show loading, unknown/unavailable, reset and update times; clear protected state on lock/401 and prevent late requests repopulating it.
4. Use existing components and native inputs; keyboard accessible controls.

## Task 4: Verify and document

1. Run focused Vitest and Python ops checks; lint changed portal files.
2. Build and locally exercise isolated instance with test-only state; verify unauthorized quota, global-password quota-only access, admin selection, no secrets, lock behavior.
3. Review full fork diff for accidental upstream edits and compatibility gaps.
4. Update FORK_CHANGELOG.md and fork docs with quota contract and verification evidence.
5. Commit quota separately from upgrade; leave production unchanged.
