# Fork Extensions

This repository tracks [`decolua/9router`](https://github.com/decolua/9router) and keeps local additions separate wherever practical.

## Viewer Portal

The fork adds a viewer-facing portal for public announcements and password-protected aggregate API-key usage and global provider quotas.

- Viewer page: `/portal`
- Administration: `/dashboard/viewer-portal`
- Internal API namespace: `/api/viewer-portal/*`
- Settings namespace: `forkExtensions.viewerPortal`

The portal publishes only explicitly selected API keys. It never exposes raw API keys, request payloads, request-level records, connection IDs, or the viewer password hash.

See [the Viewer Portal guide](gitbook/content/en/fork/viewer-portal.md) for setup, quota selection, freshness limits and fork implementation boundaries. Usage and Quota share the same viewer password; quota publication is independent of usage groups.

## Compatibility Policy

Fork features should:

1. live in new, feature-owned directories;
2. use namespaced routes and settings;
3. modify parent-owned files only for unavoidable integration hooks;
4. keep parent documentation and changelog intact;
5. include contract tests around any parent-internal data shape they consume.

The current upstream baseline and synchronization procedure are recorded in [UPSTREAM.md](UPSTREAM.md). Fork-only changes are recorded in [FORK_CHANGELOG.md](FORK_CHANGELOG.md).
