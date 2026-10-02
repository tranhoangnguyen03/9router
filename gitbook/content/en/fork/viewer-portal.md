# Viewer Portal

> **Fork extension:** This feature is maintained separately from the parent 9Router implementation.

The Viewer Portal publishes one public announcement, selected aggregate API-key usage, and global provider account quotas without giving viewers dashboard access. **Usage** and **Quota** are separate views protected by the same shared viewer password.

## Open the Surfaces

- Administration: **Dashboard → Viewer Portal** or `/dashboard/viewer-portal`
- Viewer page: `/portal`

## Configure Access

On the **General** tab:

1. choose a title and optional subtitle;
2. set the shared viewer password;
3. enable the portal;
4. copy or preview its URL.

The viewer password is independent from the dashboard password. Changing or removing it ends existing viewer sessions.

## Publish an Announcement

Use the **Announcement board** tab. Saving creates a private draft. **Publish and replace** makes the current contents live and overwrites the previous board. The public announcement appears above the password-protected usage section.

## Publish Usage Groups

Use the **Usage groups** tab to create named groups and select their API keys. Each selected key may belong to one group only. Unassigned keys remain private.

Viewers can inspect aggregate requests, input/output/cached tokens, estimated cost, models, providers, trend, and last-used time for 24 hours, 7 days, 30 days, or 60 days.

Raw API keys, request logs, payloads, endpoints, request IDs, and connection IDs are never published.

## Publish Global Quota

Use the administration **Quota** tab to select supported provider accounts, optionally set public labels, then **Save quota selection**. Only selected accounts appear in the viewer's **Quota** tab. Their private names/emails are shown to administrators only; without a public label the viewer gets a generated provider label. Inactive accounts show quota unavailable; deleted or no-longer-supported accounts are omitted.

All authenticated viewers see the same global quota cards. There is no API-key attribution, quota allocation, or grouping. Quota works without any usage groups configured. An administrator's dashboard login alone does not unlock the viewer quota API.

Cards show the upstream quota buckets, known used/total values, remaining percentage, reset/expiry time and last successful check. Unknown limits remain unknown, not zero or unlimited. Failed refreshes are marked stale when an older reading exists; an explicitly empty upstream quota set clears old readings.

## Freshness and Limits

Usage summaries are cached in server memory for up to 30 seconds. Quota checks are cached/coalesced per account for 60 seconds; the viewer refreshes approximately once a minute while the Quota view is mounted. The Refresh button reads the shared cache rather than forcing provider calls. Upstream providers may have their own caches, so **Last checked** is not a guarantee of a fresh upstream measurement.

At most 100 accounts may be published, with four actively awaited refreshes. Individual waits end after 10 seconds and the viewer response waits at most 15 seconds for quota work. The unmodified upstream handler does not propagate cancellation: a timed-out network call remains deduplicated until it settles, while other accounts can progress. For providers without an upstream timeout, that individual account may remain unavailable for the process lifetime; a process restart clears it. The cache retains at most 100 accounts (including stalled calls), so complete saturation temporarily makes new accounts unavailable until calls settle or the process restarts. No provider is called merely to render the admin account selector.

## Fork Boundaries

Configuration lives under `forkExtensions.viewerPortal.quotaAccounts`; there is no schema migration. `src/lib/viewerPortal/quota.js` is the single compatibility adapter to upstream's usage route and provider eligibility constants. It preserves upstream OAuth refresh, proxy and retry behavior and projects only safe metrics to viewers.

Viewer quota reads use `/api/viewer-portal/usage/quota`, below the existing viewer-authenticated namespace, with authentication checked before and after retrieval. Admin configuration uses `/api/viewer-portal/admin/quota` under the existing dashboard guard. No extra upstream runtime integration hook is required.

The managed deployment controller validates the new availability flag while accepting the pre-quota public response when rolling back to an older image. Older portal versions do not display quotas; do not edit portal settings through an older version if you need to retain quota configuration.

Focused checks: `cd tests && npx vitest run unit/viewer-portal-*.test.js unit/managed-*.test.js`, plus `bash ops/tests/test-ops.sh` from the repository root. Quota contract tests mock provider networks; validate real account readings separately on a reviewed deployment.
