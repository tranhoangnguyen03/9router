# Viewer Portal

> **Fork extension:** This feature is maintained separately from the parent 9Router implementation.

The Viewer Portal publishes one public announcement and selected aggregate API-key usage without giving viewers dashboard access.

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

## Freshness

Usage summaries are cached in server memory for up to 30 seconds. The viewer shows when the displayed aggregate was computed.

For the complete guide, architecture, and troubleshooting notes, see [`docs/fork/viewer-portal`](https://github.com/tranhoangnguyen03/9router/tree/master/docs/fork/viewer-portal) in the fork repository.
