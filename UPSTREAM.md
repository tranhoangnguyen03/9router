# Upstream Compatibility

## Current Baseline

- Parent repository: [`decolua/9router`](https://github.com/decolua/9router)
- Parent branch: `master`
- Parent commit: `1855aa44` (pinned upstream `master`)
- Parent release: `v0.5.119`
- Verified: 2026-11-15

Upstream's CLI and changelog identify v0.5.119, but its root application manifest still says 0.5.116. The managed version endpoint therefore reports 0.5.116; the image revision identifies the exact integrated release.

The merge preserves the Viewer Portal, managed deployment, usage attribution/cost fixes, and the trusted single-proxy login-counter fix. The Dockerfile keeps digest-pinned Node 22.23.4, deterministic installs, ffmpeg, bounded build heap, and the non-root runtime. Upstream's new lazy runtime packages and native bindings are copied from the existing lockfile-installed builder dependencies instead of running an unpinned second install. Find the integration commit with `git log --merges --oneline`.

Validation covers the 26 Python operations tests, trusted-proxy/h2c tests, the focused managed/portal/usage suite, and a broad offline comparison against pristine upstream with identical dependencies. Real-provider directories are excluded and live-only tests are not validated. Known environmental failures include missing cloud/lowdb dependencies, ffmpeg absent from the minimal test image, and read-only snapshot writes. The managed update additionally gates promotion on native container tests, a production image build, and snapshot-backed candidate checks.

Provider/model/OAuth changes are adopted from upstream without custom catalog changes. No custom logging or timeout changes are added. The Docker builder retains `NODE_OPTIONS=--max-old-space-size=1024` on the 4 GB host; the runner does not inherit this build-only limit.

The refreshed lockfile retains Next 16.4.3 and source-map-js 1.2.2, updates undici to upstream's 7.30.2 requirement, and updates node-forge to 1.4.3 now that advisory fixes are available. The production dependency audit reports zero vulnerabilities.

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
