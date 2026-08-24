# Managed 9router operations

Public traffic remains on `https://ai-router.davidustranus.space`; Caddy always proxies to `127.0.0.1:20128`. Only one process may use the live database.

## One-time controller bootstrap

Before the first managed update, install the controller directly from the reviewed checkout (do not use the older installed copy):

```bash
cd /opt/9router/repo
sudo python3 ops/9routerctl.py install
cmp ops/9routerctl.py /opt/9router/bin/9routerctl
```

This also installs and enables the boot-time recovery service while leaving the legacy production service active.

## Update

```bash
sudo 9routerctl update
sudo 9routerctl status
```

`update` fetches the fork, refuses an upstream version the fork has not incorporated, runs the focused tests as a non-root disposable container, builds a pinned image, updates the installed control plane, and starts a snapshot-backed candidate on `127.0.0.1:20130`. It does not modify production. A previous candidate's Viewer Portal configuration is carried into its replacement automatically.

Validate the candidate, then promote it during an approved cutover:

```bash
sudo 9routerctl promote --confirm-cutover
```

The first promotion also needs explicit approval to copy the already-tested Viewer Portal configuration:

```bash
sudo 9routerctl promote --confirm-cutover --apply-candidate-portal-config
```

Promotion first stops and freezes the tested candidate into an immutable WAL-aware database artifact. It then journals each durable cutover phase, stops every legacy/managed watchdog and production writer, verifies the live database is closed, creates a final verified backup, starts the managed container, checks private/public health, the exact Viewer Portal response, and a non-empty authenticated model listing, and only then enables the managed systemd watchdog. A failed or interrupted promotion is recovered from the journal automatically; the boot-time recovery service provides the same protection after a reboot.

## Roll back

If the database schema is unchanged:

```bash
sudo 9routerctl rollback --confirm-rollback
```

If the schema changed, restore the recorded pre-promotion backup:

```bash
sudo 9routerctl rollback --confirm-rollback --restore-backup /root/.9router-backups/pre-promote-<timestamp>
```

## Cleanup

Review first, then apply:

```bash
sudo 9routerctl cleanup
sudo 9routerctl cleanup --apply
```

Cleanup preserves the current and previous images, their recorded backups, and the three newest backup directories.

Do not use `npm i -g 9router` for this fork. The managed update command replaces that workflow.
