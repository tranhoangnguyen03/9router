#!/usr/bin/env python3
"""Small, root-owned deployment controller for the managed 9router fork."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

CONTROL_ROOT = Path(os.environ.get("NINEROUTER_CONTROL_ROOT", "/opt/9router"))
REPO = Path(os.environ.get("NINEROUTER_REPO", CONTROL_ROOT / "repo"))
LIVE_DATA = Path(os.environ.get("NINEROUTER_DATA", "/root/.9router"))
BACKUPS = Path(os.environ.get("NINEROUTER_BACKUPS", "/root/.9router-backups"))
CANDIDATES = CONTROL_ROOT / "candidates"
RELEASES = CONTROL_ROOT / "releases"
LOCK_FILE = Path(os.environ.get("NINEROUTER_LOCK", "/run/lock/9router-deploy.lock"))
WATCHDOG_STATE = Path(os.environ.get("NINEROUTER_WATCHDOG_STATE", "/run/9router-managed-watchdog.failures"))
OPERATION_FILE = RELEASES / "operation.json"
PREFLIGHT_FILE = RELEASES / "preflight.json"
LEGACY_WATCHDOG_UNIT = Path("/etc/systemd/system/9router-watchdog.timer")
LEGACY_WATCHDOG_SOURCE = LIVE_DATA / "ops/watchdog.timer"
LEGACY_WATCHDOG_WANTS = Path("/etc/systemd/system/timers.target.wants/9router-watchdog.timer")
EVENT_LOG = LIVE_DATA / "ops/logs/events.jsonl"
IMAGE_REPO = os.environ.get("NINEROUTER_IMAGE_REPO", "9router-viewer")
PROD_CONTAINER = "9router-prod"
CANDIDATE_CONTAINER = "9router-candidate"
CANDIDATE_PROXY = "9router-candidate-proxy"
CANDIDATE_NETWORK = "9router-candidate-internal"
CANDIDATE_PROXY_NETWORK = "9router-candidate-publish"
TEST_IMAGE = "9router-managed-tests"
VIEWER_TESTS = [
    "unit/managed-deployment.test.js",
    "unit/managed-image-contract.test.js",
    "unit/viewer-portal-cache.test.js",
    "unit/viewer-portal-config.test.js",
    "unit/viewer-portal-guard.test.js",
    "unit/viewer-portal-settings-boundary.test.js",
    "unit/viewer-portal-usage-route.test.js",
    "unit/viewer-portal-usage.test.js",
]


def run(args: list[str], *, cwd: Path | None = None, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(a) for a in args], cwd=cwd, text=True, check=check,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def require_root() -> None:
    if os.geteuid() != 0:
        raise SystemExit("This command must run as root.")


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def database_metadata(db: sqlite3.Connection) -> dict:
    tables = {row[0] for row in db.execute("select name from sqlite_master where type='table'")}
    schema = None
    if "_meta" in tables:
        row = db.execute("select value from _meta where key='schemaVersion'").fetchone()
        schema = row[0] if row else None
    counts = {}
    for table in ("providerConnections", "providerNodes", "combos", "apiKeys", "usageHistory", "requestDetails"):
        if table in tables:
            counts[table] = db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
    return {"schemaVersion": schema, "counts": counts}


def progress(message: str) -> None:
    print(f"[{datetime.now(timezone.utc).isoformat()}] {message}", flush=True)


def artifact_identity(path: Path) -> dict:
    stat = path.stat()
    return {"path": str(path), "bytes": stat.st_size, "mtimeNs": stat.st_mtime_ns, "inode": stat.st_ino}


def artifact_unchanged(path: Path, identity: dict) -> bool:
    try:
        return artifact_identity(path) == identity
    except FileNotFoundError:
        return False


def database_health(path: Path) -> dict:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=60)
    try:
        check = db.execute("pragma quick_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"database quick_check failed: {check}")
        metadata = database_metadata(db)
    finally:
        db.close()
    metadata.update({"file": str(path), "bytes": path.stat().st_size, "quickCheck": "ok"})
    return metadata


def database_summary(path: Path) -> dict:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=60)
    try:
        metadata = database_metadata(db)
    finally:
        db.close()
    metadata.update({"file": str(path), "bytes": path.stat().st_size})
    return metadata


def inspect_database(path: Path) -> dict:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=60)
    try:
        check = db.execute("pragma quick_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"database quick_check failed: {check}")
        metadata = database_metadata(db)
    finally:
        db.close()
    metadata.update({"file": str(path), "bytes": path.stat().st_size, "sha256": sha256(path), "quickCheck": "ok"})
    return metadata


def existing_parent(path: Path) -> Path:
    while not path.exists():
        path = path.parent
    return path


def require_storage(requirements: list[tuple[Path, int]], operation: str) -> None:
    by_device: dict[int, tuple[Path, int]] = {}
    for requested_path, needed in requirements:
        path = existing_parent(requested_path)
        device = path.stat().st_dev
        representative, total = by_device.get(device, (path, 0))
        by_device[device] = (representative, total + needed)
    for path, needed in by_device.values():
        free = shutil.disk_usage(path).free
        if free < needed:
            raise RuntimeError(f"not enough disk space for {operation} on {path}: need {needed:,} bytes, have {free:,}")


def database_storage_bytes(database: Path) -> int:
    return sum(path.stat().st_size for path in (
        database, Path(str(database) + "-wal"), Path(str(database) + "-shm"),
    ) if path.exists())


def backup_database(source: Path, target: Path) -> dict:
    """Create and verify a complete online SQLite backup, including WAL commits."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.unlink(missing_ok=True)
    source_db = sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=60)
    target_db = sqlite3.connect(temporary, timeout=60)
    try:
        with target_db:
            source_db.backup(target_db, pages=8192, sleep=0.05)
        check = target_db.execute("pragma quick_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"backup quick_check failed: {check}")
        metadata = database_metadata(target_db)
    finally:
        target_db.close()
        source_db.close()
    os.chmod(temporary, 0o600)
    with temporary.open("rb") as handle:
        os.fsync(handle.fileno())
    temporary.replace(target)
    fsync_directory(target.parent)
    metadata.update({
        "source": str(source),
        "file": str(target),
        "bytes": target.stat().st_size,
        "sha256": sha256(target),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "quickCheck": "ok",
    })
    return metadata


def backup_quiesced(source: Path, target: Path) -> dict:
    """Durably copy a closed, checkpointed SQLite database; verify after service resumes."""
    checkpoint_database(source)
    source_db = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        metadata = database_metadata(source_db)
    finally:
        source_db.close()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.unlink(missing_ok=True)
    try:
        shutil.copy2(source, temporary)
        os.chmod(temporary, 0o600)
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        fsync_directory(target.parent)
    finally:
        temporary.unlink(missing_ok=True)
    metadata.update({
        "source": str(source), "file": str(target), "bytes": target.stat().st_size,
        "createdAt": datetime.now(timezone.utc).isoformat(), "quickCheck": "pending",
    })
    return metadata


def verify_backup(target: Path, manifest: dict) -> dict:
    verified = inspect_database(target)
    verified.update({"source": manifest.get("source"), "createdAt": manifest.get("createdAt")})
    return verified


def sanitize_candidate(database: Path) -> None:
    db = sqlite3.connect(database)
    try:
        row = db.execute("select data from settings where id=1").fetchone()
        settings = json.loads(row[0]) if row else {}
        settings.update({
            "cloudEnabled": False,
            "tunnelEnabled": False,
            "tailscaleEnabled": False,
            "mitmEnabled": False,
            "claudeAutoPing": {},
            "codexAutoPing": {},
        })
        db.execute(
            "insert into settings(id,data) values(1,?) on conflict(id) do update set data=excluded.data",
            (json.dumps(settings, separators=(",", ":")),),
        )
        db.commit()
    finally:
        db.close()


def portal_config(db: sqlite3.Connection) -> dict | None:
    row = db.execute("select data from settings where id=1").fetchone()
    settings = json.loads(row[0]) if row else {}
    extensions = settings.get("forkExtensions")
    if isinstance(extensions, dict) and "viewerPortal" in extensions:
        return extensions["viewerPortal"]
    return settings.get("viewerPortal")


def portal_digest(portal: dict | None) -> str:
    encoded = json.dumps(portal, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def database_portal_digest(path: Path) -> str | None:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return portal_digest(portal_config(db))
    except sqlite3.OperationalError:
        return None
    finally:
        db.close()


def apply_portal_config(source: Path, target: Path, *, approved: bool) -> dict:
    source_db = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    target_db = sqlite3.connect(target)
    try:
        portal = portal_config(source_db)
        current = portal_config(target_db)
        before, after = portal_digest(current), portal_digest(portal)
        if before == after:
            return {"changed": False, "before": before, "after": after}
        if not approved:
            raise RuntimeError("portal configuration differs; pass --apply-candidate-portal-config to transfer it")
        if portal:
            referenced = {
                key_id
                for group in portal.get("groups", [])
                for key_id in group.get("apiKeyIds", [])
                if isinstance(key_id, str)
            }
            available = {row[0] for row in target_db.execute("select id from apiKeys")}
            missing = sorted(referenced - available)
            if missing:
                raise RuntimeError(f"portal references unknown API key IDs: {', '.join(missing)}")
        row = target_db.execute("select data from settings where id=1").fetchone()
        settings = json.loads(row[0]) if row else {}
        extensions = dict(settings.get("forkExtensions") or {})
        if portal is None:
            extensions.pop("viewerPortal", None)
        else:
            extensions["viewerPortal"] = portal
        settings["forkExtensions"] = extensions
        settings.pop("viewerPortal", None)
        target_db.execute(
            "insert into settings(id,data) values(1,?) on conflict(id) do update set data=excluded.data",
            (json.dumps(settings, separators=(",", ":")),),
        )
        target_db.commit()
        return {"changed": True, "before": before, "after": after}
    finally:
        source_db.close()
        target_db.close()


def copy_portal_config(source: Path, target: Path) -> bool:
    source_db = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        portal = portal_config(source_db)
    finally:
        source_db.close()
    if not portal:
        return False
    apply_portal_config(source, target, approved=True)
    return True


def container_security_args(*, restart: str = "always", memory: str = "1536m") -> list[str]:
    return [
        "--restart", restart,
        "--read-only",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m,uid=1000,gid=1000",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--memory", memory,
        "--memory-swap", "2g" if memory == "1536m" else "1536m",
        "--cpus", "2",
        "--pids-limit", "512",
        "--log-driver", "json-file",
        "--log-opt", "max-size=20m",
        "--log-opt", "max-file=5",
    ]


def docker_exists(name: str) -> bool:
    result = run(["docker", "inspect", name], capture=True, check=False)
    return result.returncode == 0


def remove_container(name: str) -> None:
    if not docker_exists(name):
        return
    running = run(["docker", "inspect", "-f", "{{.State.Running}}", name], capture=True).stdout.strip() == "true"
    if running:
        run(["docker", "stop", "--time", "30", name])
    run(["docker", "rm", name])


def stop_candidate() -> None:
    remove_container(CANDIDATE_PROXY)
    remove_container(CANDIDATE_CONTAINER)
    for network in (CANDIDATE_NETWORK, CANDIDATE_PROXY_NETWORK):
        run(["docker", "network", "rm", network], check=False, capture=True)


def chown_tree(path: Path, uid: int = 1000, gid: int = 1000) -> None:
    for root, dirs, files in os.walk(path):
        os.chown(root, uid, gid)
        for name in dirs:
            os.chown(Path(root) / name, uid, gid)
        for name in files:
            os.chown(Path(root) / name, uid, gid)


def wait_http(url: str, *, timeout: int = 60) -> None:
    deadline = time.monotonic() + timeout
    last_error = "not attempted"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if 200 <= response.status < 300:
                    return
                last_error = f"HTTP {response.status}"
        except Exception as exc:  # bounded retry; final error reported
            last_error = str(exc)
        time.sleep(1)
    raise RuntimeError(f"health check failed for {url}: {last_error}")


def wait_models(url: str, database: Path, *, timeout: int = 30) -> None:
    db = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        row = db.execute("select key from apiKeys where isActive = 1 limit 1").fetchone()
    finally:
        db.close()
    if not row:
        raise RuntimeError("no active API key is available for routing validation")
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {row[0]}"})
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                payload = json.load(response)
                if response.status == 200 and isinstance(payload.get("data"), list) and payload["data"]:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError(f"authenticated model-list validation failed for {url}")


def expected_public_portal(database: Path) -> dict:
    db = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        portal = portal_config(db) or {}
        valid_ids = {row[0] for row in db.execute("select id from apiKeys")}
    finally:
        db.close()
    enabled = portal.get("enabled") is True
    groups = portal.get("groups") if isinstance(portal.get("groups"), list) else []
    has_valid_group = any(
        any(key_id in valid_ids for key_id in group.get("apiKeyIds", []))
        for group in groups if isinstance(group, dict)
    )
    return {
        "enabled": enabled,
        "title": (portal.get("title") or "9Router").strip(),
        "subtitle": (portal.get("subtitle") or "").strip(),
        "board": portal.get("publishedBoard") if enabled else None,
        "usageAvailable": enabled and bool(portal.get("passwordHash")) and has_valid_group,
    }


def wait_portal(url: str, database: Path, *, timeout: int = 30) -> None:
    expected = expected_public_portal(database)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if response.status == 200 and json.load(response) == expected:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError(f"Viewer Portal response does not match finalized configuration: {url}")


def start_candidate(image: str, data: Path, port: int = 20130) -> None:
    stop_candidate()
    chown_tree(data)
    run(["docker", "network", "create", "--internal", CANDIDATE_NETWORK])
    run([
        "docker", "network", "create", "--opt",
        "com.docker.network.bridge.enable_ip_masquerade=false", CANDIDATE_PROXY_NETWORK,
    ])
    app_args = [
        "docker", "run", "-d", "--name", CANDIDATE_CONTAINER,
        "--network", CANDIDATE_NETWORK,
        *container_security_args(restart="no", memory="1g"),
        "--user", "1000:1000",
        "-v", f"{data}:/app/data",
        "-e", "HOME=/tmp",
        "-e", "DATA_DIR=/app/data",
        "-e", "PORT=20128",
        "-e", "HOSTNAME=0.0.0.0",
        "-e", "NODE_ENV=production",
        "-e", "NINEROUTER_MANAGED_DEPLOYMENT=true",
        "-e", "DISABLE_BACKGROUND_TOKEN_REFRESH=1",
        image,
    ]
    run(app_args)
    proxy_code = (
        'const n=require("net");n.createServer(c=>{const u=n.connect(20128,"'
        + CANDIDATE_CONTAINER
        + '");c.pipe(u).pipe(c);u.on("error",()=>c.destroy())}).listen(20130,"0.0.0.0")'
    )
    run([
        "docker", "create", "--name", CANDIDATE_PROXY, "--no-healthcheck", "--network", CANDIDATE_PROXY_NETWORK,
        *container_security_args(restart="no", memory="1g"),
        "--user", "1000:1000", "--entrypoint", "node",
        "-p", f"127.0.0.1:{port}:20130", image, "-e", proxy_code,
    ])
    run(["docker", "network", "connect", CANDIDATE_NETWORK, CANDIDATE_PROXY])
    run(["docker", "start", CANDIDATE_PROXY])
    wait_http(f"http://127.0.0.1:{port}/api/health")
    wait_portal(f"http://127.0.0.1:{port}/api/viewer-portal/public", data / "db/data.sqlite")


def image_id(image: str) -> str:
    return run(["docker", "image", "inspect", image, "--format", "{{.Id}}"], capture=True).stdout.strip()


def container_image_id(name: str) -> str:
    return run(["docker", "inspect", "-f", "{{.Image}}", name], capture=True).stdout.strip()


def candidate_database(candidate: dict) -> Path:
    return Path(candidate.get("finalizedDatabase") or Path(candidate["data"]) / "db/data.sqlite")


def finalize_candidate(candidate: dict, *, metadata_path: Path | None = None) -> dict:
    candidate = dict(candidate)
    source = Path(candidate["data"]) / "db/data.sqlite"
    finalized = Path(candidate["data"]).parent / "finalized/data.sqlite"
    if candidate.get("finalizedDatabase"):
        checked = inspect_database(candidate_database(candidate))
        if checked["sha256"] != candidate.get("database", {}).get("sha256"):
            raise RuntimeError("finalized candidate database changed")
        return candidate
    if not source.exists() and finalized.exists():
        manifest = inspect_database(finalized)
    else:
        if not source.exists():
            raise RuntimeError(f"candidate database not found: {source}")
        if docker_exists(CANDIDATE_CONTAINER):
            if container_image_id(CANDIDATE_CONTAINER) != candidate["imageId"]:
                raise RuntimeError("candidate container image does not match candidate metadata")
            wait_http(candidate["healthUrl"], timeout=10)
            candidate["healthPassedAt"] = datetime.now(timezone.utc).isoformat()
        elif not candidate.get("healthPassedAt"):
            raise RuntimeError("candidate is not running and has no recorded successful health check")
        remove_container(CANDIDATE_PROXY)
        remove_container(CANDIDATE_CONTAINER)
        for network in (CANDIDATE_NETWORK, CANDIDATE_PROXY_NETWORK):
            run(["docker", "network", "rm", network], check=False, capture=True)
        wait_database_closed(source)
        require_storage([(source.parent, database_storage_bytes(source) + 128 * 1024 * 1024)], "candidate finalization")
        manifest = backup_database(source, finalized)
    manifest["finalizedAt"] = datetime.now(timezone.utc).isoformat()
    candidate.update({
        "finalizedDatabase": str(finalized),
        "database": manifest,
        "portalDigest": database_portal_digest(finalized),
        "finalizedAt": manifest["finalizedAt"],
    })
    if metadata_path:
        write_json(metadata_path, candidate)
        data = Path(candidate["data"])
        if data.exists():
            shutil.rmtree(data)
            fsync_directory(data.parent)
    return candidate


def git_output(*args: str) -> str:
    return run(["git", *args], cwd=REPO, capture=True).stdout.strip()


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as handle:
        handle.write(json.dumps(value, indent=2) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    fsync_directory(path.parent)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def release_state() -> tuple[dict | None, dict | None]:
    state_path = RELEASES / "state.json"
    if state_path.exists():
        state = read_json(state_path)
        return state.get("current"), state.get("previous")
    current_path, previous_path = RELEASES / "current.json", RELEASES / "previous.json"
    return (
        read_json(current_path) if current_path.exists() else None,
        read_json(previous_path) if previous_path.exists() else None,
    )


def write_release_state(current: dict, previous: dict) -> None:
    write_json(RELEASES / "state.json", {"current": current, "previous": previous})


def clear_operation() -> None:
    OPERATION_FILE.unlink(missing_ok=True)
    OPERATION_FILE.with_suffix(".json.tmp").unlink(missing_ok=True)
    if OPERATION_FILE.parent.exists():
        fsync_directory(OPERATION_FILE.parent)


def write_operation(operation: dict) -> None:
    write_json(OPERATION_FILE, operation)


def complete_promotion_cleanup(candidate_path: Path) -> None:
    candidate_path.unlink(missing_ok=True)
    fsync_directory(candidate_path.parent)
    PREFLIGHT_FILE.unlink(missing_ok=True)
    fsync_directory(PREFLIGHT_FILE.parent)
    clear_operation()


def finish_promotion_commit(current: dict, previous: dict, candidate_path: Path) -> str | None:
    write_release_state(current, previous)
    try:
        complete_promotion_cleanup(candidate_path)
        return None
    except BaseException as exc:
        # Runtime/state are already committed. Never roll back for terminal metadata cleanup.
        reconcile_release(current)
        warning = f"promotion committed; deferred metadata cleanup: {exc}"
        progress(f"WARNING: {warning}")
        return warning


def release_schema(release: dict) -> str | None:
    return (
        (release.get("liveDatabase") or {}).get("schemaVersion")
        or (release.get("database") or {}).get("schemaVersion")
        or release.get("schemaVersion")
    )


def run_tests() -> None:
    run(["docker", "build", "--target", "tests", "-t", TEST_IMAGE, "."], cwd=REPO)
    try:
        run([
            "docker", "run", "--rm", "--read-only",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,uid=1000,gid=1000",
            "--tmpfs", "/app/tests/node_modules/.vite-temp:rw,nosuid,nodev,size=64m,uid=1000,gid=1000",
            "--user", "1000:1000", TEST_IMAGE,
            "npm", "test", "--prefix", "tests", "--", "--run", *VIEWER_TESTS,
        ])
    finally:
        run(["docker", "image", "rm", TEST_IMAGE], check=False, capture=True)


def prepare_candidate(*, fetch: bool, portal_from: Path | None) -> dict:
    require_root()
    candidate_path = RELEASES / "candidate.json"
    previous_candidate = read_json(candidate_path) if candidate_path.exists() else None
    if portal_from and not portal_from.exists():
        raise RuntimeError(f"portal source not found: {portal_from}")
    if not portal_from and previous_candidate:
        previous_database = candidate_database(previous_candidate)
        if previous_database.exists():
            portal_from = previous_database
    if git_output("status", "--porcelain"):
        raise RuntimeError("repository is not clean")
    if fetch:
        remotes = set(git_output("remote").splitlines())
        if "fork" in remotes:
            run(["git", "fetch", "fork", "feat/viewer-portal"], cwd=REPO)
            run(["git", "merge", "--no-edit", "fork/feat/viewer-portal"], cwd=REPO)
        if "upstream" in remotes:
            run(["git", "fetch", "upstream", "master"], cwd=REPO)
            fresh = run(["git", "merge-base", "--is-ancestor", "upstream/master", "HEAD"], cwd=REPO, check=False)
            if fresh.returncode != 0:
                raise RuntimeError("the fork has not incorporated current upstream/master; merge and review it first")
    sha = git_output("rev-parse", "HEAD")
    short = sha[:12]
    image = f"{IMAGE_REPO}:{short}"
    source_database = LIVE_DATA / "db/data.sqlite"
    docker_root = Path(run(["docker", "info", "--format", "{{.DockerRootDir}}"], capture=True).stdout.strip())
    require_storage([
        (CONTROL_ROOT, database_storage_bytes(source_database) + 128 * 1024 * 1024),
        (docker_root, 2 * 1024 * 1024 * 1024),
    ], "candidate build and snapshot")
    run_tests()
    run(["docker", "build", "--build-arg", f"VCS_REF={sha}", "-t", image, "."], cwd=REPO)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    data = CANDIDATES / f"{short}-{stamp}" / "data"
    (data / "db").mkdir(parents=True, mode=0o700)
    backup_database(source_database, data / "db/data.sqlite")
    for relative in ("jwt-secret", "machine-id", "auth/cli-secret"):
        source = LIVE_DATA / relative
        if source.exists():
            destination = data / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    portal_copied = bool(portal_from and portal_from.exists() and copy_portal_config(portal_from, data / "db/data.sqlite"))
    sanitize_candidate(data / "db/data.sqlite")
    manifest = inspect_database(data / "db/data.sqlite")
    manifest["createdAt"] = datetime.now(timezone.utc).isoformat()
    (data / "db/.migrated-from-json").write_text("managed candidate snapshot\n")
    start_candidate(image, data)
    candidate = {
        "gitSha": sha,
        "image": image,
        "imageId": image_id(image),
        "data": str(data),
        "database": manifest,
        "portalConfigCopied": portal_copied,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "healthPassedAt": datetime.now(timezone.utc).isoformat(),
        "healthUrl": "http://127.0.0.1:20130/api/health",
    }
    write_json(candidate_path, candidate)
    if previous_candidate:
        previous_root = Path(previous_candidate["data"]).parent
        if previous_root != data.parent and previous_root.is_relative_to(CANDIDATES):
            shutil.rmtree(previous_root, ignore_errors=True)
    install_control_plane(quiet=True)
    return candidate


def prepare_live_permissions() -> None:
    LIVE_DATA.mkdir(parents=True, exist_ok=True)
    os.chown(LIVE_DATA, 0, 0)
    os.chmod(LIVE_DATA, 0o755)
    required_dirs = ("auth", "bin", "db", "headroom", "logs", "mitm", "pxpipe", "runtime", "tailscale", "tunnel")
    for name in required_dirs:
        path = LIVE_DATA / name
        path.mkdir(parents=True, exist_ok=True)
        chown_tree(path)
    secret = LIVE_DATA / "fork-viewer-portal-jwt-secret"
    if not secret.exists():
        fd = os.open(secret, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(secrets.token_urlsafe(48))
    for child in LIVE_DATA.iterdir():
        if child.is_file():
            os.chown(child, 1000, 1000)
            os.chmod(child, 0o600)


def run_production(image: str) -> None:
    remove_container(PROD_CONTAINER)
    run([
        "docker", "run", "-d", "--name", PROD_CONTAINER,
        *container_security_args(),
        "--user", "1000:1000",
        "-p", "127.0.0.1:20128:20128",
        "-v", f"{LIVE_DATA}:/app/data",
        "-e", "HOME=/tmp",
        "-e", "DATA_DIR=/app/data",
        "-e", "PORT=20128",
        "-e", "HOSTNAME=0.0.0.0",
        "-e", "NODE_ENV=production",
        "-e", "NINEROUTER_MANAGED_DEPLOYMENT=true",
        "-e", "BASE_URL=https://ai-router.davidustranus.space",
        "-e", "NEXT_PUBLIC_BASE_URL=https://ai-router.davidustranus.space",
        image,
    ])


def systemctl(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return run(["systemctl", *args], check=check, capture=not check)


def is_active(unit: str) -> bool:
    return systemctl("is-active", "--quiet", unit, check=False).returncode == 0


def is_enabled(unit: str) -> bool:
    if unit == "9router-watchdog.timer":
        return LEGACY_WATCHDOG_WANTS.exists()
    return systemctl("is-enabled", "--quiet", unit, check=False).returncode == 0


def ensure_legacy_watchdog_unit() -> None:
    if not LEGACY_WATCHDOG_SOURCE.exists():
        raise RuntimeError(f"legacy watchdog unit source is missing: {LEGACY_WATCHDOG_SOURCE}")
    if not LEGACY_WATCHDOG_UNIT.exists():
        LEGACY_WATCHDOG_UNIT.symlink_to(LEGACY_WATCHDOG_SOURCE)
        systemctl("daemon-reload")


def disable_legacy_autostart() -> None:
    systemctl("disable", "9router.service")
    LEGACY_WATCHDOG_WANTS.unlink(missing_ok=True)
    fsync_directory(LEGACY_WATCHDOG_WANTS.parent)
    if is_enabled("9router.service") or is_enabled("9router-watchdog.timer"):
        raise RuntimeError("failed to disable legacy 9router autostart")


def locked():
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    handle = LOCK_FILE.open("a+")
    fcntl.flock(handle, fcntl.LOCK_EX)
    return handle


def under_lock(function, *args, **kwargs):
    lock = locked()
    try:
        recover_operation()
        return function(*args, **kwargs)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def wait_port_free(port: int, *, timeout: int = 30) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as probe:
            probe.settimeout(0.5)
            if probe.connect_ex(("127.0.0.1", port)) != 0:
                return
        time.sleep(0.25)
    raise RuntimeError(f"port {port} is still in use")


def wait_database_closed(database: Path | None = None, *, timeout: int = 30) -> None:
    database = database or LIVE_DATA / "db/data.sqlite"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = run(["lsof", "-t", "--", database], capture=True, check=False)
        if result.returncode == 1:
            return
        if result.returncode not in (0, 1):
            raise RuntimeError(f"lsof failed while checking {database}: {result.stderr.strip()}")
        time.sleep(0.25)
    raise RuntimeError(f"database is still open: {database}")


def stop_legacy() -> None:
    systemctl("stop", "9router-watchdog.timer", "9router-watchdog.service")
    systemctl("stop", "9router.service")
    wait_port_free(20128)
    wait_database_closed()


def stop_all_writers() -> None:
    systemctl(
        "stop", "9router-watchdog.timer", "9router-watchdog.service",
        "9router-managed-watchdog.timer", "9router-managed-watchdog.service", check=False,
    )
    systemctl("stop", "9router.service", check=False)
    remove_container(PROD_CONTAINER)
    active = [unit for unit in (
        "9router-watchdog.timer", "9router-watchdog.service", "9router-managed-watchdog.timer",
        "9router-managed-watchdog.service", "9router.service",
    ) if is_active(unit)]
    if active:
        raise RuntimeError(f"failed to stop units: {', '.join(active)}")
    wait_port_free(20128)
    wait_database_closed()


def disable_autostart() -> None:
    disable_legacy_autostart()
    units = ("9router-managed-watchdog.timer",)
    systemctl("disable", *units)
    enabled = [unit for unit in ("9router.service", "9router-watchdog.timer", *units) if is_enabled(unit)]
    if enabled:
        raise RuntimeError(f"failed to disable autostart units: {', '.join(enabled)}")


def enable_watchdog(unit: str) -> None:
    if unit == "9router-watchdog.timer":
        ensure_legacy_watchdog_unit()
    systemctl("enable", "--now", unit)
    if not is_active(unit) or not is_enabled(unit):
        raise RuntimeError(f"watchdog did not become active and enabled: {unit}")


def start_release(release: dict) -> None:
    if release.get("kind") == "systemd":
        systemctl("disable", "--now", "9router-managed-watchdog.timer", check=False)
        systemctl("enable", "--now", release.get("unit", "9router.service"))
        if not is_active(release.get("unit", "9router.service")):
            raise RuntimeError("legacy 9router service did not start")
        wait_http("http://127.0.0.1:20128/")
        enable_watchdog("9router-watchdog.timer")
    else:
        systemctl("stop", "9router.service", "9router-watchdog.timer", check=False)
        disable_legacy_autostart()
        prepare_live_permissions()
        run_production(release["imageId"])
        wait_http("http://127.0.0.1:20128/api/health")
        enable_watchdog("9router-managed-watchdog.timer")


def recover_release(release: dict, backup: Path | None = None) -> None:
    stop_all_writers()
    disable_autostart()
    if backup and (backup / "data.sqlite").exists():
        restore_database(backup)
    start_release(release)


def release_healthy(release: dict) -> bool:
    if release.get("kind") == "systemd":
        return is_active(release.get("unit", "9router.service")) and url_ok("http://127.0.0.1:20128/")
    return (
        docker_exists(PROD_CONTAINER)
        and run(["docker", "inspect", "-f", "{{.State.Running}}", PROD_CONTAINER], capture=True, check=False).stdout.strip() == "true"
        and url_ok("http://127.0.0.1:20128/api/health")
    )


def reconcile_release(release: dict) -> None:
    if release_healthy(release):
        if release.get("kind") == "systemd":
            systemctl("disable", "--now", "9router-managed-watchdog.timer", check=False)
            enable_watchdog("9router-watchdog.timer")
        else:
            systemctl("stop", "9router.service", "9router-watchdog.timer", check=False)
            disable_legacy_autostart()
            enable_watchdog("9router-managed-watchdog.timer")
        return
    stop_all_writers()
    start_release(release)


def recover_operation() -> None:
    if not OPERATION_FILE.exists():
        return
    operation = read_json(OPERATION_FILE)
    if operation.get("phase") == "committed":
        current = operation["nextCurrent"]
        previous = operation.get("nextPrevious") or {}
        write_release_state(current, previous)
        reconcile_release(current)
        if operation.get("type") == "promote":
            (RELEASES / "candidate.json").unlink(missing_ok=True)
    else:
        prior = operation.get("priorState") or {}
        original = operation.get("originalRelease")
        backup_value = operation.get("backupDir")
        if not original:
            raise RuntimeError("operation journal is missing its original release")
        recover_release(original, Path(backup_value) if backup_value else None)
        if prior.get("current"):
            write_release_state(prior["current"], prior.get("previous") or {})
    clear_operation()


def portal_change(source: Path, target: Path) -> tuple[str, str]:
    source_db = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    target_db = sqlite3.connect(f"file:{target}?mode=ro", uri=True)
    try:
        return portal_digest(portal_config(target_db)), portal_digest(portal_config(source_db))
    finally:
        source_db.close()
        target_db.close()


def preflight() -> dict:
    require_root()
    candidate_path = RELEASES / "candidate.json"
    if not candidate_path.exists():
        raise RuntimeError("no tested candidate metadata found")
    candidate = read_json(candidate_path)
    if not candidate.get("finalizedDatabase"):
        progress("Preflight 1/6: freezing candidate; production remains online (several minutes expected).")
        candidate = finalize_candidate(candidate, metadata_path=candidate_path)
    else:
        progress("Preflight 1/6: candidate is already frozen.")
    candidate_db = candidate_database(candidate)

    progress("Preflight 2/6: verifying frozen candidate database; production remains online.")
    checked_candidate = inspect_database(candidate_db)
    if checked_candidate["sha256"] != candidate.get("database", {}).get("sha256"):
        raise RuntimeError("candidate database changed after finalization")
    if database_portal_digest(candidate_db) != candidate.get("portalDigest"):
        raise RuntimeError("candidate portal configuration changed after finalization")
    if image_id(candidate["image"]) != candidate["imageId"]:
        raise RuntimeError("candidate image identity changed")

    progress("Preflight 3/6: checking live database integrity; production remains online.")
    live_health = database_health(LIVE_DATA / "db/data.sqlite")
    before, after = portal_change(candidate_db, LIVE_DATA / "db/data.sqlite")

    progress("Preflight 4/6: checking storage and recovery services.")
    live_size = database_storage_bytes(LIVE_DATA / "db/data.sqlite")
    require_storage([
        (BACKUPS, live_size * 2 + 128 * 1024 * 1024),
        (LIVE_DATA, live_size + 128 * 1024 * 1024),
    ], "safe promotion and automatic rollback")
    if not is_enabled("9router-managed-recovery.service"):
        raise RuntimeError("boot-time deployment recovery service is not enabled")
    if not url_ok("https://ai-router.davidustranus.space/api/health"):
        raise RuntimeError("production public health is not ready")

    progress("Preflight 5/6: recording immutable candidate and controller identity.")
    result = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        "candidateGitSha": candidate.get("gitSha"),
        "candidateImageId": candidate["imageId"],
        "candidatePortalDigest": candidate["portalDigest"],
        "candidateArtifact": artifact_identity(candidate_db),
        "controllerSha256": sha256(Path(__file__)),
        "portalTransferRequired": before != after,
        "liveDatabase": live_health,
        "publicHealth": True,
    }
    write_json(PREFLIGHT_FILE, result)
    progress("Preflight 6/6: complete. No production process was stopped or modified.")
    return result


def validated_preflight(candidate: dict, apply_candidate_portal_config: bool) -> tuple[dict, Path]:
    if not PREFLIGHT_FILE.exists():
        raise RuntimeError("cutover preflight is missing; run 9routerctl preflight first")
    checked = read_json(PREFLIGHT_FILE)
    expires = datetime.fromisoformat(checked["expiresAt"])
    if datetime.now(timezone.utc) > expires:
        raise RuntimeError("cutover preflight expired; run 9routerctl preflight again")
    candidate_db = candidate_database(candidate)
    if not candidate.get("finalizedDatabase") or not artifact_unchanged(candidate_db, checked["candidateArtifact"]):
        raise RuntimeError("frozen candidate changed after preflight")
    if candidate.get("gitSha") != checked.get("candidateGitSha") or candidate.get("imageId") != checked.get("candidateImageId"):
        raise RuntimeError("candidate metadata changed after preflight")
    if sha256(Path(__file__)) != checked.get("controllerSha256"):
        raise RuntimeError("deployment controller changed after preflight")
    if database_portal_digest(candidate_db) != checked.get("candidatePortalDigest"):
        raise RuntimeError("candidate portal configuration changed after preflight")
    if checked.get("portalTransferRequired") and not apply_candidate_portal_config:
        raise RuntimeError("portal configuration differs; pass --apply-candidate-portal-config to transfer it")
    if not is_enabled("9router-managed-recovery.service"):
        raise RuntimeError("boot-time deployment recovery service is not enabled")
    if not url_ok("https://ai-router.davidustranus.space/api/health"):
        raise RuntimeError("production public health is not ready")
    live_size = database_storage_bytes(LIVE_DATA / "db/data.sqlite")
    require_storage([
        (BACKUPS, live_size * 2 + 128 * 1024 * 1024),
        (LIVE_DATA, live_size + 128 * 1024 * 1024),
    ], "safe promotion and automatic rollback")
    return checked, candidate_db


def promote(confirm: bool, apply_candidate_portal_config: bool = False) -> dict:
    require_root()
    if not confirm:
        raise RuntimeError("promotion requires --confirm-cutover")
    lock = locked()
    previous = None
    backup_dir = None
    stopped = False
    try:
        recover_operation()
        candidate_path = RELEASES / "candidate.json"
        if not candidate_path.exists():
            raise RuntimeError("no tested candidate metadata found")
        progress("Cutover 1/7: validating fresh preflight; production remains online.")
        candidate = read_json(candidate_path)
        _, candidate_db = validated_preflight(candidate, apply_candidate_portal_config)

        existing_current, existing_previous = release_state()
        if existing_current:
            previous = dict(existing_current)
            previous.setdefault("kind", "image")
        else:
            previous = {"kind": "systemd", "unit": "9router.service"}
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup_dir = BACKUPS / f"pre-promote-{stamp}"
        operation = {
            "id": f"promote-{stamp}", "type": "promote", "phase": "prepared",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "originalRelease": previous,
            "priorState": {"current": existing_current, "previous": existing_previous},
            "candidate": candidate,
            "backupDir": str(backup_dir),
        }
        write_operation(operation)

        progress("Cutover 2/7: stopping the sole production writer. Customer-impact timer starts now.")
        outage_started = time.monotonic()
        stopped = True
        stop_all_writers()
        disable_autostart()
        progress("Cutover 3/7: writing durable checkpointed backup (measured near 9 seconds).")
        manifest = backup_quiesced(LIVE_DATA / "db/data.sqlite", backup_dir / "data.sqlite")
        write_json(backup_dir / "manifest.json", manifest)
        previous.setdefault("schemaVersion", manifest.get("schemaVersion"))
        operation.update({"phase": "backed-up", "originalRelease": previous})
        write_operation(operation)
        progress("Cutover 4/7: applying approved Portal configuration and starting managed container.")
        portal_transfer = apply_portal_config(
            candidate_db, LIVE_DATA / "db/data.sqlite", approved=apply_candidate_portal_config,
        )
        prepare_live_permissions()
        run_production(candidate["imageId"])
        wait_http("http://127.0.0.1:20128/api/health")
        wait_http("https://ai-router.davidustranus.space/api/health")
        progress(f"TRAFFIC RESTORED after {time.monotonic() - outage_started:.1f} seconds; remaining checks do not interrupt service.")
        progress("Cutover 5/7: validating Portal, authenticated models, and backup while serving traffic.")
        wait_portal("https://ai-router.davidustranus.space/api/viewer-portal/public", LIVE_DATA / "db/data.sqlite")
        wait_models("https://ai-router.davidustranus.space/v1/models", LIVE_DATA / "db/data.sqlite")
        manifest = verify_backup(backup_dir / "data.sqlite", manifest)
        write_json(backup_dir / "manifest.json", manifest)
        disable_legacy_autostart()
        enable_watchdog("9router-managed-watchdog.timer")
        current = {
            "kind": "image", **candidate,
            "promotedAt": datetime.now(timezone.utc).isoformat(),
            "prePromotionBackup": str(backup_dir),
            "portalTransfer": portal_transfer,
            "liveDatabase": database_summary(LIVE_DATA / "db/data.sqlite"),
        }
        operation.update({"phase": "committed", "nextCurrent": current, "nextPrevious": previous})
        write_operation(operation)
        progress("Cutover 6/7: committing release state and managed watchdog.")
        finish_promotion_commit(current, previous, candidate_path)
        progress("Cutover 7/7: complete.")
        return current
    except BaseException as original:
        progress(f"Cutover failed: {original}. Starting automatic recovery.")
        if OPERATION_FILE.exists():
            try:
                recover_operation()
            except BaseException as recovery:
                raise RuntimeError(f"promotion failed and journal recovery also failed: {recovery}") from original
        elif stopped and previous:
            try:
                recover_release(previous, backup_dir)
            except BaseException as recovery:
                raise RuntimeError(f"promotion failed and automatic recovery also failed: {recovery}") from original
        raise
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def checkpoint_database(database: Path) -> None:
    db = sqlite3.connect(database, timeout=60)
    try:
        busy, _, _ = db.execute("pragma wal_checkpoint(truncate)").fetchone()
        if busy:
            raise RuntimeError(f"database checkpoint remained busy: {database}")
    finally:
        db.close()


def restore_database(backup: Path, *, preserve_current: bool = True) -> Path | None:
    source = backup / "data.sqlite" if backup.is_dir() else backup
    if not source.exists():
        raise RuntimeError(f"backup not found: {source}")
    checked_source = inspect_database(source)
    manifest_path = backup / "manifest.json" if backup.is_dir() else backup.parent / "manifest.json"
    if manifest_path.exists():
        recorded = read_json(manifest_path).get("sha256")
        if recorded and recorded != checked_source["sha256"]:
            raise RuntimeError("backup checksum does not match its manifest")

    database = LIVE_DATA / "db/data.sqlite"
    database.parent.mkdir(parents=True, exist_ok=True)
    failed_dir = None
    if database.exists():
        checkpoint_database(database)
        if sha256(database) == checked_source["sha256"]:
            return None
        if preserve_current:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            failed_dir = BACKUPS / f"failed-{stamp}"
            manifest = backup_database(database, failed_dir / "data.sqlite")
            write_json(failed_dir / "manifest.json", manifest)

    temporary = database.with_name(f".{database.name}.restore-{os.getpid()}")
    temporary.unlink(missing_ok=True)
    try:
        shutil.copy2(source, temporary)
        verify = sqlite3.connect(f"file:{temporary}?mode=ro", uri=True)
        try:
            copied_result = verify.execute("pragma quick_check").fetchone()[0]
        finally:
            verify.close()
        if copied_result != "ok":
            raise RuntimeError(f"restored copy quick_check failed: {copied_result}")
        os.chown(temporary, 1000, 1000)
        os.chmod(temporary, 0o600)
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        for suffix in ("-wal", "-shm"):
            Path(str(database) + suffix).unlink(missing_ok=True)
        fsync_directory(database.parent)
        os.replace(temporary, database)
        directory_fd = os.open(database.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)
    return failed_dir


def rollback(confirm: bool, restore: Path | None) -> None:
    require_root()
    if not confirm:
        raise RuntimeError("rollback requires --confirm-rollback")
    lock = locked()
    current = previous = None
    pre_rollback = None
    stopped = False
    try:
        recover_operation()
        current, previous = release_state()
        if current and current.get("rolledBackAt"):
            return
        if not current:
            raise RuntimeError("no current release metadata found")
        if not previous:
            raise RuntimeError("no previous release metadata found")
        if restore:
            source = restore / "data.sqlite" if restore.is_dir() else restore
            inspect_database(source)
        else:
            live_schema = inspect_database(LIVE_DATA / "db/data.sqlite").get("schemaVersion")
            if release_schema(previous) != live_schema:
                raise RuntimeError("database schema changed; rollback requires --restore-backup")
        live_size = max(
            database_storage_bytes(LIVE_DATA / "db/data.sqlite"),
            (restore / "data.sqlite" if restore and restore.is_dir() else restore).stat().st_size if restore else 0,
        )
        require_storage([
            (BACKUPS, live_size * 2 + 128 * 1024 * 1024),
            (LIVE_DATA, live_size + 128 * 1024 * 1024),
        ], "safe rollback recovery")

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        pre_rollback = BACKUPS / f"pre-rollback-{stamp}"
        operation = {
            "id": f"rollback-{stamp}", "type": "rollback", "phase": "prepared",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "originalRelease": current,
            "priorState": {"current": current, "previous": previous},
            "targetRelease": previous,
            "backupDir": str(pre_rollback),
        }
        write_operation(operation)

        stopped = True
        stop_all_writers()
        disable_autostart()
        manifest = backup_quiesced(LIVE_DATA / "db/data.sqlite", pre_rollback / "data.sqlite")
        write_json(pre_rollback / "manifest.json", manifest)
        operation["phase"] = "backed-up"
        write_operation(operation)
        if restore:
            restore_database(restore, preserve_current=False)
        start_release(previous)
        wait_http("https://ai-router.davidustranus.space/api/health" if previous.get("kind") != "systemd" else "https://ai-router.davidustranus.space/")
        wait_models("https://ai-router.davidustranus.space/v1/models", LIVE_DATA / "db/data.sqlite")
        if previous.get("kind") != "systemd":
            wait_portal("https://ai-router.davidustranus.space/api/viewer-portal/public", LIVE_DATA / "db/data.sqlite")
        manifest = verify_backup(pre_rollback / "data.sqlite", manifest)
        write_json(pre_rollback / "manifest.json", manifest)
        rolled_back = {
            **previous,
            "rolledBackAt": datetime.now(timezone.utc).isoformat(),
            "preRollbackBackup": str(pre_rollback),
        }
        operation.update({"phase": "committed", "nextCurrent": rolled_back, "nextPrevious": current or {}})
        write_operation(operation)
        write_release_state(rolled_back, current or {})
        clear_operation()
    except BaseException as original:
        if OPERATION_FILE.exists():
            try:
                recover_operation()
            except BaseException as recovery:
                raise RuntimeError(f"rollback failed and journal recovery also failed: {recovery}") from original
        elif stopped and current:
            try:
                recover_release(current, pre_rollback)
            except BaseException as recovery:
                raise RuntimeError(f"rollback failed and automatic recovery also failed: {recovery}") from original
        raise
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def cleanup_plan() -> list[tuple[str, Path | str]]:
    actions: list[tuple[str, Path | str]] = []
    candidate_path = RELEASES / "candidate.json"
    current_state, previous_state = release_state()
    current, previous = current_state or {}, previous_state or {}
    candidate_meta = read_json(candidate_path) if candidate_path.exists() else {}

    pending_candidate = bool(candidate_meta and candidate_database(candidate_meta).exists())
    if not pending_candidate:
        if candidate_path.exists():
            actions.append(("remove-file", candidate_path))
        for name in (CANDIDATE_PROXY, CANDIDATE_CONTAINER):
            if docker_exists(name):
                actions.append(("remove-container", name))
        for network in (CANDIDATE_NETWORK, CANDIDATE_PROXY_NETWORK):
            if run(["docker", "network", "inspect", network], check=False, capture=True).returncode == 0:
                actions.append(("remove-network", network))

    keep_candidate_dir = Path(candidate_meta["data"]).parent if pending_candidate else None
    if CANDIDATES.exists():
        for candidate in CANDIDATES.iterdir():
            if candidate.is_dir() and candidate != keep_candidate_dir:
                actions.append(("remove-tree", candidate))

    if BACKUPS.exists():
        backup_dirs = sorted((p for p in BACKUPS.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True)
        protected = set(backup_dirs[:3])
        for release in (current, previous):
            for key in ("prePromotionBackup", "preRollbackBackup"):
                recorded = release.get(key)
                if recorded:
                    protected.add(Path(recorded))
        for path in backup_dirs:
            if path not in protected:
                actions.append(("remove-tree", path))

    keep_images = {value for value in (current.get("imageId"), previous.get("imageId")) if value}
    if pending_candidate and candidate_meta.get("imageId"):
        keep_images.add(candidate_meta["imageId"])
    images = run(
        ["docker", "image", "ls", IMAGE_REPO, "--format", "{{.ID}} {{.Repository}}:{{.Tag}}"],
        check=False, capture=True,
    ).stdout.splitlines()
    for line in images:
        short_id, tag = line.split(maxsplit=1)
        full_id = run(["docker", "image", "inspect", tag, "--format", "{{.Id}}"], capture=True).stdout.strip()
        if full_id not in keep_images:
            actions.append(("remove-image", tag))
    return actions


def cleanup(apply: bool) -> None:
    actions = cleanup_plan()
    if not actions:
        print("Nothing to clean.")
        return
    for action, target in actions:
        print(f"{action}: {target}")
    if not apply:
        print("Dry run only; pass --apply to remove listed targets.")
        return
    for action, target in actions:
        if action == "remove-tree":
            shutil.rmtree(target)
        elif action == "remove-container":
            remove_container(str(target))
        elif action == "remove-network":
            run(["docker", "network", "rm", str(target)], check=False)
        elif action == "remove-image":
            run(["docker", "image", "rm", str(target)], check=False)
        elif action == "remove-file":
            Path(target).unlink(missing_ok=True)


def url_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return 200 <= response.status < 400
    except Exception:
        return False


def append_event(event: dict) -> None:
    EVENT_LOG.parent.mkdir(parents=True, exist_ok=True)
    with EVENT_LOG.open("a") as handle:
        handle.write(json.dumps(event, separators=(",", ":")) + "\n")


def watchdog() -> None:
    require_root()
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    lock = LOCK_FILE.open("a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        append_event({"ts": datetime.now(timezone.utc).isoformat(), "level": "info", "mode": "managed", "action": "maintenance lock active"})
        return
    try:
        running = docker_exists(PROD_CONTAINER) and run(
            ["docker", "inspect", "-f", "{{.State.Running}}", PROD_CONTAINER], capture=True, check=False
        ).stdout.strip() == "true"
        private = url_ok("http://127.0.0.1:20128/api/health")
        public = url_ok("https://ai-router.davidustranus.space/api/health")
        failures = int(WATCHDOG_STATE.read_text() or "0") if WATCHDOG_STATE.exists() else 0
        failures = 0 if running and private else failures + 1
        WATCHDOG_STATE.write_text(str(failures))
        action = ""
        if not running:
            run(["docker", "start", PROD_CONTAINER])
            wait_http("http://127.0.0.1:20128/api/health")
            action = f"started {PROD_CONTAINER} (container stopped)"
        elif failures >= 3:
            run(["docker", "restart", PROD_CONTAINER])
            wait_http("http://127.0.0.1:20128/api/health")
            WATCHDOG_STATE.write_text("0")
            action = f"restarted {PROD_CONTAINER} (private health failed 3 times)"
        if action:
            running = True
            private = url_ok("http://127.0.0.1:20128/api/health")
            public = url_ok("https://ai-router.davidustranus.space/api/health")
        level = "ok" if running and private and public else "warn"
        append_event({
            "ts": datetime.now(timezone.utc).isoformat(), "level": level, "mode": "managed",
            "checks": {
                "process": running, "private": private, "public": public,
            },
            **({"action": action} if action else {}),
        })
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def status() -> None:
    current, previous = release_state()
    state = {
        "oldSystemdService": is_active("9router.service"),
        "productionContainer": docker_exists(PROD_CONTAINER) and run(
            ["docker", "inspect", "-f", "{{.State.Running}}", PROD_CONTAINER], capture=True, check=False,
        ).stdout.strip() == "true",
        "candidateContainer": docker_exists(CANDIDATE_CONTAINER),
        "privateHealth": url_ok("http://127.0.0.1:20128/api/health") or url_ok("http://127.0.0.1:20128/"),
        "publicHealth": url_ok("https://ai-router.davidustranus.space/api/health"),
        "candidateHealth": url_ok("http://127.0.0.1:20130/api/health"),
        "current": current,
        "previous": previous,
        "operation": read_json(OPERATION_FILE) if OPERATION_FILE.exists() else None,
        "preflight": read_json(PREFLIGHT_FILE) if PREFLIGHT_FILE.exists() else None,
        "candidate": read_json(RELEASES / "candidate.json") if (RELEASES / "candidate.json").exists() else None,
    }
    print(json.dumps(state, indent=2))


def install_control_plane(*, quiet: bool = False) -> None:
    require_root()
    source_script = REPO / "ops/9routerctl.py"
    source_units = REPO / "ops/systemd"
    if not source_script.exists() or not source_units.exists():
        raise RuntimeError(f"control-plane sources are missing from {REPO / 'ops'}")
    bin_dir = CONTROL_ROOT / "bin"
    installed_units = CONTROL_ROOT / "ops/systemd"
    bin_dir.mkdir(parents=True, exist_ok=True)
    installed_units.mkdir(parents=True, exist_ok=True)
    target = bin_dir / "9routerctl"
    shutil.copy2(source_script, target)
    os.chmod(target, 0o755)
    units = (
        "9router-managed-recovery.service",
        "9router-managed-watchdog.service",
        "9router-managed-watchdog.timer",
    )
    for unit in units:
        shutil.copy2(source_units / unit, installed_units / unit)
        shutil.copy2(source_units / unit, Path("/etc/systemd/system") / unit)
    symlink = Path("/usr/local/sbin/9routerctl")
    symlink.unlink(missing_ok=True)
    symlink.symlink_to(target)
    systemctl("daemon-reload")
    systemctl("enable", "9router-managed-recovery.service")
    current, _ = release_state()
    if current:
        reconcile_release(current)
    else:
        systemctl("disable", "--now", "9router-managed-watchdog.timer", check=False)
        ensure_legacy_watchdog_unit()
        systemctl("enable", "9router.service", "9router-watchdog.timer")
    if not quiet:
        print(f"Installed {target}; watchdog state matches the active release.")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="9routerctl")
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("install")
    backup = commands.add_parser("backup")
    backup.add_argument("--source", type=Path, default=LIVE_DATA / "db/data.sqlite")
    backup.add_argument("--target", type=Path)
    update = commands.add_parser("update")
    update.add_argument("--no-fetch", action="store_true")
    update.add_argument("--portal-from", type=Path)
    commands.add_parser("preflight")
    promote_command = commands.add_parser("promote")
    promote_command.add_argument("--confirm-cutover", action="store_true")
    promote_command.add_argument("--apply-candidate-portal-config", action="store_true")
    rollback_command = commands.add_parser("rollback")
    rollback_command.add_argument("--confirm-rollback", action="store_true")
    rollback_command.add_argument("--restore-backup", type=Path)
    cleanup_command = commands.add_parser("cleanup")
    cleanup_command.add_argument("--apply", action="store_true")
    commands.add_parser("status")
    commands.add_parser("watchdog")
    commands.add_parser("recover")
    commands.add_parser("stop-candidate")
    return result


def main() -> None:
    args = parser().parse_args()
    if args.command == "install":
        install_control_plane()
    elif args.command == "backup":
        require_root()
        target = args.target or BACKUPS / datetime.now(timezone.utc).strftime("manual-%Y%m%dT%H%M%SZ") / "data.sqlite"
        manifest = under_lock(backup_database, args.source, target)
        write_json(target.parent / "manifest.json", manifest)
        print(json.dumps(manifest, indent=2))
    elif args.command == "update":
        candidate = under_lock(prepare_candidate, fetch=not args.no_fetch, portal_from=args.portal_from)
        print(json.dumps(candidate, indent=2))
    elif args.command == "preflight":
        print(json.dumps(under_lock(preflight), indent=2))
    elif args.command == "promote":
        print(json.dumps(promote(args.confirm_cutover, args.apply_candidate_portal_config), indent=2))
    elif args.command == "rollback":
        rollback(args.confirm_rollback, args.restore_backup)
    elif args.command == "cleanup":
        under_lock(cleanup, args.apply)
    elif args.command == "status":
        status()
    elif args.command == "watchdog":
        watchdog()
    elif args.command == "recover":
        require_root()
        lock = locked()
        try:
            recover_operation()
            current, _ = release_state()
            reconcile_release(current or {"kind": "systemd", "unit": "9router.service"})
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()
    elif args.command == "stop-candidate":
        require_root()
        under_lock(stop_candidate)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
