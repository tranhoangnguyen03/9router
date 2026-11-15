# Fork Changelog

This file records additions maintained by this fork. Parent release history remains in `CHANGELOG.md` unchanged.

## 2026-11-15

- Integrated upstream v0.5.119 (`1855aa44`), preserving the Viewer Portal, managed deployment, usage attribution/cost fixes, and trusted-proxy login isolation.
- Bundled upstream's lazy runtime packages and native bindings from the existing deterministic install, preserving the non-root/read-only runtime.
- Updated undici to 7.30.2 and node-forge to 1.4.3; production dependency audit is clean.
- Retained upstream's root application version 0.5.116; its CLI/changelog identify release v0.5.119. Managed image revisions disambiguate the deployed source.

## 2026-10-26

- Integrated upstream v0.5.111 (`3a978a63`), preserving the Viewer Portal, managed deployment, safe API-key usage attribution, and stored cost breakdowns.
- Updated the digest-pinned non-root runtime to Node 22.23.4 and included ffmpeg for upstream audio conversion support; retained deterministic npm installs and bounded build heap.
- Refreshed the dependency lockfile, including patched source-map-js 1.2.2. The remaining node-forge signature-verification advisory has no published fix; the app's only direct use is certificate generation, not signature verification.
- Restored upstream's transactional duplicate-usage-write protection, which an earlier fork merge had dropped, without losing stored cost breakdowns; added usage/concurrency and dashboard security checks to the managed deployment gate.
- Added regression checks combining legacy token-count fallbacks with cost breakdowns and safe key attribution; adapted the upstream audio runtime check to preserve the non-root image contract.

## 2026-09-23

- Added viewer sorting by total tokens and estimated cost for published groups and keys, plus Tokens/Cost/Requests trend modes and visible mobile totals.
- Show provider credit balances as available currency instead of misleading percentage quotas; clarify quota refresh caching.
- Keep group expansion consistent across configuration changes and aggregate long-period last-used timestamps in SQLite rather than transferring every matching history row.

## 2026-09-12

- Merged upstream 0.5.75 snapshot `17c4cc76`, preserving managed deployment and Viewer Portal hooks.
- Added a global Quota view behind the existing viewer password, separate from Usage.
- Added a Quota administration tab for selecting supported accounts and optional public labels; private identities and credentials are excluded from viewer responses.
- Reused upstream quota retrieval through one fork-owned adapter, with bounded/coalesced refreshes, unknown/stale states, and publication/authentication rechecks.
- Added quota configuration, security, concurrency, upstream-handler and deployment compatibility tests. No upstream-owned runtime file was changed for this feature.

## 2026-08-22

### Added

- Public Viewer Portal at `/portal`.
- Public single-board announcements with separate draft and publish states.
- Shared-password viewer sessions independent from dashboard authentication.
- Named, ordered groups of explicitly published API keys.
- Aggregate request, token, estimated-cost, model, provider, trend, and last-used reporting.
- 24-hour, 7-day, 30-day, and 60-day ranges.
- Thirty-second bounded in-memory aggregate cache with concurrent-request coalescing.
- Viewer Portal administration under `/dashboard/viewer-portal`.
- Fork-owned compatibility, security-boundary, aggregation, and cache tests.

### Security

- Raw API keys and viewer password hashes are excluded from viewer, administration, and generic settings responses.
- Viewer authentication is checked before every usage response, including cache hits.
- Password rotation and portal disablement invalidate existing viewer sessions.
- Browser responses containing portal state or usage use `Cache-Control: no-store`.
