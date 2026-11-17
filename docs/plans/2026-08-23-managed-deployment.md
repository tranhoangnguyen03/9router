# Managed 9router Deployment Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Replace the global npm deployment with a reproducible, container-managed Viewer Portal deployment that supports snapshot testing, controlled promotion, rollback, watchdog recovery, and targeted cleanup.

**Architecture:** Caddy keeps the public URL and fixed backend `127.0.0.1:20128`. Exactly one production process writes `/root/.9router`; candidates use verified SQLite snapshots on port 20130. A root-owned `9routerctl` performs update, promotion, rollback, status, and cleanup while coordinating with a systemd watchdog through a maintenance lock.

**Tech Stack:** Next.js, Vitest, Docker, Bash, Python stdlib `sqlite3`, systemd, Caddy.

---

### Task 1: Managed-deployment application safety

**Files:**
- Modify: `src/app/api/health/route.js`
- Modify: `src/app/api/version/route.js`
- Modify: `src/app/api/version/update/route.js`
- Modify: `src/app/api/version/shutdown/route.js`
- Test: `tests/unit/managed-deployment.test.js`

1. Write tests requiring DB-aware health and managed-mode updater rejection.
2. Run the focused test and confirm it fails for the missing behavior.
3. Add the minimum environment-gated behavior.
4. Run the focused test and the Viewer Portal suite.

### Task 2: Reproducible non-root image

**Files:**
- Modify: `.gitignore`
- Modify: `tests/.gitignore`
- Add: `package-lock.json`
- Add: `tests/package-lock.json`
- Modify: `Dockerfile`
- Test: `tests/unit/managed-image-contract.test.js`

1. Write a contract test for lockfiles, `npm ci`, pinned base digest, revision label, non-root runtime, healthcheck, and absence of recursive runtime ownership changes.
2. Run it and confirm failure.
3. Apply the minimum Dockerfile and ignore-file changes.
4. Run the contract test and build the image with a Git revision build argument.

### Task 3: Deployment control plane

**Files:**
- Add: `ops/9routerctl`
- Add: `ops/managed-watchdog.sh`
- Add: `ops/systemd/9router-managed-watchdog.service`
- Add: `ops/systemd/9router-managed-watchdog.timer`
- Add: `ops/tests/test-ops.sh`

1. Write shell checks for syntax, dry-run cleanup, full SQLite backup integrity, maintenance locking, and required container security flags.
2. Run checks and confirm failure before implementation.
3. Implement one `9routerctl` with `backup`, `update`, `promote`, `rollback`, `status`, and `cleanup` subcommands.
4. Keep `promote` gated by an explicit confirmation flag and never invoke it during preparation.
5. Implement a consecutive-failure watchdog that does nothing while the deployment lock is held.
6. Run shell checks.

### Task 4: Candidate proof

**Files:**
- Runtime only under `/opt/9router` and `/root/.9router-backups`; no production service changes.

1. Install root-owned control-plane files without enabling the managed watchdog.
2. Create a fresh online snapshot and verify `PRAGMA quick_check` plus key table counts.
3. Build the SHA-labeled candidate.
4. Start it outbound-isolated on `127.0.0.1:20130` with background side effects disabled.
5. Verify health, portal, public portal API, updater rejection, image labels, non-root/read-only/cap-drop/log rotation, and blocked outbound access.
6. Confirm the existing `9router.service`, Caddy, and public models endpoint remain healthy.

### Task 5: Review and handoff

1. Run the full focused test set, production build, shell checks, and runtime acceptance checks.
2. Review the diff for secret leakage and destructive defaults.
3. Record candidate SHA/image digest, backup metadata, residual risks, and the exact promotion gate.
4. Stop before live promotion, reboot, or old-service cleanup pending explicit user approval.
