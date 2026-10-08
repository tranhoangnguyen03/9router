# Upstream Compatibility

## Current Baseline

- Parent repository: [`decolua/9router`](https://github.com/decolua/9router)
- Parent branch: `master`
- Parent commit: `ce4460ef` (resolved upstream `master`)
- Parent release: `v0.5.99`
- Verified: 2026-10-08

The merge preserves the Viewer Portal and managed deployment extensions. The Dockerfile conflict was resolved in favor of the fork's pinned base, lockfile-based build, and non-root runtime; upstream's root entrypoint and unlocked `npm install` were not adopted. Find the local integration commit with `git log --merges --oneline`.

Upgrade checks: 24 Python operations tests, 98 focused managed/portal/usage/Responses tests, and `git diff --check` passed. The broad offline suite passed 3414 tests with 87 assertion failures; 85 also fail on pristine upstream v0.5.99 (3335 passed, 101 failed). The remaining two tests passed on focused recheck in both checkouts (21 tests total). Collection failures include missing cloud/lowdb dependencies and node:test files without Vitest suites. Live-provider tests were excluded. The committed historical no-regression gate is stale for this upstream version. The managed update additionally runs focused container tests and a production image build before candidate promotion.

This integration incorporates the already-deployed v0.5.95 fork history before updating to v0.5.99. The four Responses completion/abort fixes discussed during the disconnect investigation were already present in production v0.5.95; this update does not establish or fix the cause of that disconnect. No custom logging or timeout changes were added.

The v0.5.95 usage-repository conflict preserves full API-key composite aggregation (upstream's collision fix), fork cost breakdowns, and safe API-key IDs. Fork usage changes also span `open-sse` usage tracking/pricing, `src/lib/db/repos/usageRepo.js`, and usage dashboard components; review these alongside the portal integration files.

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
