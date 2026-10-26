# Upstream Compatibility

## Current Baseline

- Parent repository: [`decolua/9router`](https://github.com/decolua/9router)
- Parent branch: `master`
- Parent commit: `3a978a63` (pinned upstream `master`)
- Parent release: `v0.5.111`
- Verified: 2026-10-26

The merge preserves the Viewer Portal and managed deployment extensions. The Dockerfile keeps digest-pinned Node 22.23.4, deterministic installs, and the non-root runtime while adding upstream's ffmpeg requirement; upstream's root entrypoint was not adopted. Find the integration commit with `git log --merges --oneline`.

Upgrade checks: 24 Python operations tests, 177 focused managed/portal/usage/Responses/fallback tests, 103 targeted rechecks, touched-file ESLint, and `git diff --check` passed. The final broad run passed 4172 tests with 43 assertion failures versus 4077 passed and 46 failed on pristine v0.5.111; there were no new assertion or collection failures. Both runs also had 15 expected failures and 24 skips. Network access was disabled, real-provider directories were excluded, and live-only tests were not validated. Known environmental failures include missing cloud/lowdb dependencies, ffmpeg absent from the minimal comparison image, and read-only snapshot writes. The two xAI discovery failures were intermittent, not fixed by this integration. The managed update additionally gates promotion on native container tests, a production image build, and snapshot-backed candidate checks.

The actual provider/model/OAuth exports exactly match pristine upstream. Historical provider and alias snapshots miss SenseNova and Runcrate in both checkouts; OAuth URL verification passes. No custom logging or timeout changes were added. The Docker builder retains `NODE_OPTIONS=--max-old-space-size=1024` on the 4 GB host; the runner does not inherit this build-only limit.

The refreshed lockfile resolves Next 16.4.3, undici 7.30.1, and patched source-map-js 1.2.2. Production dependency audit still reports the node-forge RSA signature-verification advisory with no published fix. The only direct app use is certificate generation in `src/mitm/cert/rootCA.js`, not the affected signature-verification operation.

The usage merge combines upstream's trimmed key lookup and legacy token fallbacks with full API-key composite aggregation, fork cost breakdowns, and safe API-key IDs. Upstream's transactional duplicate-write protection, dropped by an earlier fork merge, is restored and its concurrency test passes. Fork usage changes also span `open-sse` usage tracking/pricing and dashboard components; review these alongside the portal integration files.

## Integration Budget

The Viewer Portal intentionally changes only these parent-owned runtime files:

| File | Reason |
|---|---|
| `src/dashboardGuard.js` | Allows the public viewer endpoints to reach their own session checks |
| `src/app/api/settings/route.js` | Prevents the fork settings namespace and secrets from entering the generic settings API |
| `src/shared/components/Sidebar.js` | Adds the dashboard navigation entry |
| `gitbook/constants/docsConfig.js` | Adds one clearly labeled fork-documentation section |

All other Viewer Portal implementation and tests live in new fork-owned paths.

Managed deployment additionally touches `Dockerfile`, `.gitignore`, `src/app/api/health/route.js`, and the `src/app/api/version/{route.js,update/route.js,shutdown/route.js}` endpoints. It owns the root/test lockfiles, `ops/`, and managed-deployment tests/docs. Preserve these hooks on each merge. The Dockerfile keeps the pinned base, npm ci and non-root runner while incorporating upstream runtime dependencies (including node-machine-id).

## Synchronizing From Parent

1. Fetch the parent branch.
2. Confirm the expected parent commit and review its release notes.
3. Merge parent `master` into a temporary synchronization branch.
4. Resolve the four integration files above deliberately; do not accept either side wholesale.
5. Run the parent test suite and the `viewer-portal-*` tests.
6. Verify that `/portal`, `/dashboard/viewer-portal`, and `/api/viewer-portal/*` still map to the intended boundaries.
7. Update the baseline in this file after the merge is accepted.

Useful read-only checks:

```bash
git ls-remote upstream refs/heads/master
git diff --name-status <previous-upstream>..<new-upstream>
git log --oneline <previous-upstream>..<new-upstream>
```

## Compatibility Contracts

The portal relies on these parent behaviors:

- API keys are resolved through `getApiKeys()`.
- Detailed usage is stored in `usageHistory`.
- Daily summaries store API-key aggregates under `usageDaily.data.byApiKey`.
- Dashboard authentication is enforced by `dashboardGuard.js`.
- Theme and common UI primitives are exported from `src/shared/components`.

If a parent update changes one of these contracts, adapt only the fork-owned portal adapter when possible. Expand the integration budget only after an explicit review.
