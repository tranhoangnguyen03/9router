# Upstream Compatibility

## Current Baseline

- Parent repository: [`decolua/9router`](https://github.com/decolua/9router)
- Parent branch: `master`
- Parent commit: `699edac3273e13d4744bc46f6082618f08560702`
- Parent release: `v0.5.55`
- Local merge commit: `4df13c6624c4dc51e7d640e5c10970142089a0a5`
- Verified: 2026-08-22

The local tree at the merge commit matches the parent tree. Fork extensions are applied in later commits.

## Integration Budget

The Viewer Portal intentionally changes only these parent-owned runtime files:

| File | Reason |
|---|---|
| `src/dashboardGuard.js` | Allows the public viewer endpoints to reach their own session checks |
| `src/app/api/settings/route.js` | Prevents the fork settings namespace and secrets from entering the generic settings API |
| `src/shared/components/Sidebar.js` | Adds the dashboard navigation entry |
| `gitbook/constants/docsConfig.js` | Adds one clearly labeled fork-documentation section |

All other Viewer Portal implementation and tests live in new fork-owned paths.

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
