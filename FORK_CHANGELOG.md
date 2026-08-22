# Fork Changelog

This file records additions maintained by this fork. Parent release history remains in `CHANGELOG.md` unchanged.

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
