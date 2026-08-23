#!/usr/bin/env python3
"""Small, root-owned deployment controller for the managed 9router fork."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

CONTROL_ROOT = Path(os.environ.get("NINEROUTER_CONTROL_ROOT", "/opt/9router"))
REPO = Path(os.environ.get("NINEROUTER_REPO", CONTROL_ROOT / "repo"))
LIVE_DATA = Path(os.environ.get("NINEROUTER_DATA", "/root/.9router"))
BACKUPS = Path(os.environ.get("NINEROUTER_BACKUPS", "/root/.9router-backups"))
CANDIDATES = CONTROL_ROOT / "candidates"
RELEASES = CONTROL_ROOT / "releases"
LOCK_FILE = Path(os.environ.get("NINEROUTER_LOCK", "/run/lock/9router-deploy.lock"))
WATCHDOG_STATE = Path(os.environ.get("NINEROUTER_WATCHDOG_STATE", "/run/9router-managed-watchdog.failures"))
EVENT_LOG = LIVE_DATA / "ops/logs/events.jsonl"
IMAGE_REPO = os.environ.get("NINEROUTER_IMAGE_REPO", "9router-viewer")
PROD_CONTAINER = "9router-prod"
CANDIDATE_CONTAINER = "9router-candidate"
CANDIDATE_PROXY = "9router-candidate-proxy"
CANDIDATE_NETWORK = "9router-candidate-internal"
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
    temporary.replace(target)
    metadata.update({
        "source": str(source),
        "file": str(target),
        "bytes": target.stat().st_size,
        "sha256": sha256(target),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "quickCheck": "ok",
    })
    return metadata


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


def copy_portal_config(source: Path, target: Path) -> bool:
    source_db = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    target_db = sqlite3.connect(target)
    try:
        source_row = source_db.execute("select data from settings where id=1").fetchone()
        target_row = target_db.execute("select data from settings where id=1").fetchone()
        source_settings = json.loads(source_row[0]) if source_row else {}
        portal = source_settings.get("forkExtensions", {}).get("viewerPortal") or source_settings.get("viewerPortal")
        if not portal:
            return False
        target_settings = json.loads(target_row[0]) if target_row else {}
        extensions = dict(target_settings.get("forkExtensions") or {})
        extensions["viewerPortal"] = portal
        target_settings["forkExtensions"] = extensions
        target_settings.pop("viewerPortal", None)
        target_db.execute(
            "insert into settings(id,data) values(1,?) on conflict(id) do update set data=excluded.data",
            (json.dumps(target_settings, separators=(",", ":")),),
        )
        target_db.commit()
        return True
    finally:
        source_db.close()
        target_db.close()


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
    if docker_exists(name):
        run(["docker", "rm", "-f", name], check=False, capture=True)


def stop_candidate() -> None:
    remove_container(CANDIDATE_PROXY)
    remove_container(CANDIDATE_CONTAINER)
    run(["docker", "network", "rm", CANDIDATE_NETWORK], check=False, capture=True)


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


def start_candidate(image: str, data: Path, port: int = 20130) -> None:
    stop_candidate()
    chown_tree(data)
    run(["docker", "network", "create", "--internal", CANDIDATE_NETWORK])
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
        "docker", "create", "--name", CANDIDATE_PROXY,
        *container_security_args(restart="no", memory="1g"),
        "--user", "1000:1000", "--entrypoint", "node",
        "-p", f"127.0.0.1:{port}:20130", image, "-e", proxy_code,
    ])
    run(["docker", "network", "connect", CANDIDATE_NETWORK, CANDIDATE_PROXY])
    run(["docker", "start", CANDIDATE_PROXY])
    wait_http(f"http://127.0.0.1:{port}/api/health")


def image_id(image: str) -> str:
    return run(["docker", "image", "inspect", image, "--format", "{{.Id}}"], capture=True).stdout.strip()


def git_output(*args: str) -> str:
    return run(["git", *args], cwd=REPO, capture=True).stdout.strip()


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def run_tests() -> None:
    run(["npm", "ci", "--no-audit", "--no-fund"], cwd=REPO)
    run(["npm", "ci", "--no-audit", "--no-fund"], cwd=REPO / "tests")
    run(["npm", "test", "--", "--run", *VIEWER_TESTS], cwd=REPO / "tests")


def prepare_candidate(*, fetch: bool, portal_from: Path | None) -> dict:
    require_root()
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
    run_tests()
    sha = git_output("rev-parse", "HEAD")
    short = sha[:12]
    image = f"{IMAGE_REPO}:{short}"
    run(["docker", "build", "--build-arg", f"VCS_REF={sha}", "-t", image, "."], cwd=REPO)
    data = CANDIDATES / short / "data"
    if data.exists():
        shutil.rmtree(data)
    (data / "db").mkdir(parents=True, mode=0o700)
    manifest = backup_database(LIVE_DATA / "db/data.sqlite", data / "db/data.sqlite")
    for relative in ("jwt-secret", "machine-id", "auth/cli-secret"):
        source = LIVE_DATA / relative
        if source.exists():
            destination = data / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    portal_copied = bool(portal_from and portal_from.exists() and copy_portal_config(portal_from, data / "db/data.sqlite"))
    sanitize_candidate(data / "db/data.sqlite")
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
        "healthUrl": "http://127.0.0.1:20130/api/health",
    }
    write_json(RELEASES / "candidate.json", candidate)
    return candidate


def prepare_live_permissions() -> None:
    LIVE_DATA.mkdir(parents=True, exist_ok=True)
    os.chown(LIVE_DATA, 0, 0)
    os.chmod(LIVE_DATA, 0o755)
    required_dirs = ("auth", "bin", "db", "logs", "mitm", "runtime", "tailscale", "tunnel")
    for name in required_dirs:
        path = LIVE_DATA / name
        path.mkdir(parents=True, exist_ok=True)
        chown_tree(path)
    for child in LIVE_DATA.iterdir():
        if child.is_file():
            os.chown(child, 1000, 1000)


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


def locked():
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    handle = LOCK_FILE.open("a+")
    fcntl.flock(handle, fcntl.LOCK_EX)
    return handle


def promote(confirm: bool) -> dict:
    require_root()
    if not confirm:
        raise RuntimeError("promotion requires --confirm-cutover")
    candidate_path = RELEASES / "candidate.json"
    if not candidate_path.exists():
        raise RuntimeError("no tested candidate metadata found")
    candidate = read_json(candidate_path)
    wait_http(candidate["healthUrl"], timeout=10)
    lock = locked()
    previous = None
    try:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_dir = BACKUPS / f"pre-promote-{stamp}"
        manifest = backup_database(LIVE_DATA / "db/data.sqlite", backup_dir / "data.sqlite")
        write_json(backup_dir / "manifest.json", manifest)
        current_path = RELEASES / "current.json"
        if current_path.exists():
            previous = {"kind": "image", **read_json(current_path)}
        else:
            previous = {"kind": "systemd", "unit": "9router.service"}
        write_json(RELEASES / "previous.json", previous)

        systemctl("stop", "9router-watchdog.timer", check=False)
        systemctl("stop", "9router-managed-watchdog.timer", check=False)
        if is_active("9router.service"):
            systemctl("stop", "9router.service")
        remove_container(PROD_CONTAINER)
        prepare_live_permissions()
        run_production(candidate["imageId"])
        wait_http("http://127.0.0.1:20128/api/health")
        wait_http("https://ai-router.davidustranus.space/api/health")
        systemctl("disable", "9router.service", check=False)
        systemctl("disable", "9router-watchdog.timer", check=False)
        systemctl("enable", "--now", "9router-managed-watchdog.timer", check=False)
        current = {
            **candidate,
            "promotedAt": datetime.now(timezone.utc).isoformat(),
            "prePromotionBackup": str(backup_dir),
        }
        write_json(current_path, current)
        return current
    except Exception:
        remove_container(PROD_CONTAINER)
        if previous and previous.get("kind") == "systemd":
            systemctl("enable", "--now", "9router.service", check=False)
            systemctl("enable", "--now", "9router-watchdog.timer", check=False)
        elif previous and previous.get("imageId"):
            run_production(previous["imageId"])
        raise
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def restore_database(backup: Path) -> None:
    source = backup / "data.sqlite" if backup.is_dir() else backup
    if not source.exists():
        raise RuntimeError(f"backup not found: {source}")
    check = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        result = check.execute("pragma quick_check").fetchone()[0]
    finally:
        check.close()
    if result != "ok":
        raise RuntimeError(f"refusing corrupt backup: {result}")
    database = LIVE_DATA / "db/data.sqlite"
    failed = database.with_name(f"data.failed-{int(time.time())}.sqlite")
    database.replace(failed)
    shutil.copy2(source, database)
    os.chown(database, 1000, 1000)
    for suffix in ("-wal", "-shm"):
        Path(str(database) + suffix).unlink(missing_ok=True)


def rollback(confirm: bool, restore: Path | None) -> None:
    require_root()
    if not confirm:
        raise RuntimeError("rollback requires --confirm-rollback")
    previous_path = RELEASES / "previous.json"
    if not previous_path.exists():
        raise RuntimeError("no previous release metadata found")
    previous = read_json(previous_path)
    lock = locked()
    try:
        systemctl("stop", "9router-managed-watchdog.timer", check=False)
        remove_container(PROD_CONTAINER)
        if restore:
            restore_database(restore)
        if previous.get("kind") == "systemd":
            systemctl("enable", "--now", "9router.service", check=False)
            systemctl("enable", "--now", "9router-watchdog.timer", check=False)
        else:
            run_production(previous["imageId"])
        wait_http("http://127.0.0.1:20128/api/health" if previous.get("kind") != "systemd" else "http://127.0.0.1:20128/")
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def cleanup_plan() -> list[tuple[str, Path | str]]:
    actions: list[tuple[str, Path | str]] = []
    current_path = RELEASES / "current.json"
    candidate_path = RELEASES / "candidate.json"
    current = read_json(current_path) if current_path.exists() else {}
    previous = read_json(RELEASES / "previous.json") if (RELEASES / "previous.json").exists() else {}
    candidate_meta = read_json(candidate_path) if candidate_path.exists() else {}

    for name in (CANDIDATE_PROXY, CANDIDATE_CONTAINER):
        if docker_exists(name):
            actions.append(("remove-container", name))
    if run(["docker", "network", "inspect", CANDIDATE_NETWORK], check=False, capture=True).returncode == 0:
        actions.append(("remove-network", CANDIDATE_NETWORK))

    keep_candidate_dir = None if current else (Path(candidate_meta["data"]).parent if candidate_meta.get("data") else None)
    if CANDIDATES.exists():
        for candidate in CANDIDATES.iterdir():
            if candidate.is_dir() and candidate != keep_candidate_dir:
                actions.append(("remove-tree", candidate))

    if BACKUPS.exists():
        backup_dirs = sorted((p for p in BACKUPS.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True)
        protected = set(backup_dirs[:2])
        recorded = current.get("prePromotionBackup")
        if recorded:
            protected.add(Path(recorded))
        for path in backup_dirs:
            if path not in protected:
                actions.append(("remove-tree", path))

    keep_images = {value for value in (current.get("imageId"), previous.get("imageId")) if value}
    if not current and candidate_meta.get("imageId"):
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
            run(["docker", "start", PROD_CONTAINER], check=False)
            action = f"started {PROD_CONTAINER} (container stopped)"
        elif failures >= 3:
            run(["docker", "restart", PROD_CONTAINER], check=False)
            WATCHDOG_STATE.write_text("0")
            action = f"restarted {PROD_CONTAINER} (private health failed 3 times)"
        level = "ok" if running and private and public else "warn"
        append_event({
            "ts": datetime.now(timezone.utc).isoformat(), "level": level, "mode": "managed",
            "checks": {
                "process": running, "root": private, "api": private,
                "tunnel": True, "public": True, "direct": public,
            },
            **({"action": action} if action else {}),
        })
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def status() -> None:
    state = {
        "oldSystemdService": is_active("9router.service"),
        "productionContainer": docker_exists(PROD_CONTAINER),
        "candidateContainer": docker_exists(CANDIDATE_CONTAINER),
        "privateHealth": url_ok("http://127.0.0.1:20128/api/health") or url_ok("http://127.0.0.1:20128/"),
        "publicHealth": url_ok("https://ai-router.davidustranus.space/api/health"),
        "candidateHealth": url_ok("http://127.0.0.1:20130/api/health"),
        "current": read_json(RELEASES / "current.json") if (RELEASES / "current.json").exists() else None,
        "candidate": read_json(RELEASES / "candidate.json") if (RELEASES / "candidate.json").exists() else None,
    }
    print(json.dumps(state, indent=2))


def install_control_plane() -> None:
    require_root()
    source_root = Path(__file__).resolve().parent
    bin_dir = CONTROL_ROOT / "bin"
    ops_dir = CONTROL_ROOT / "ops"
    bin_dir.mkdir(parents=True, exist_ok=True)
    ops_dir.mkdir(parents=True, exist_ok=True)
    target = bin_dir / "9routerctl"
    shutil.copy2(Path(__file__), target)
    os.chmod(target, 0o755)
    for unit in ("9router-managed-watchdog.service", "9router-managed-watchdog.timer"):
        shutil.copy2(source_root / "systemd" / unit, Path("/etc/systemd/system") / unit)
    symlink = Path("/usr/local/sbin/9routerctl")
    symlink.unlink(missing_ok=True)
    symlink.symlink_to(target)
    systemctl("daemon-reload")
    print(f"Installed {target}; managed watchdog remains disabled until promotion.")


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
    promote_command = commands.add_parser("promote")
    promote_command.add_argument("--confirm-cutover", action="store_true")
    rollback_command = commands.add_parser("rollback")
    rollback_command.add_argument("--confirm-rollback", action="store_true")
    rollback_command.add_argument("--restore-backup", type=Path)
    cleanup_command = commands.add_parser("cleanup")
    cleanup_command.add_argument("--apply", action="store_true")
    commands.add_parser("status")
    commands.add_parser("watchdog")
    commands.add_parser("stop-candidate")
    return result


def main() -> None:
    args = parser().parse_args()
    if args.command == "install":
        install_control_plane()
    elif args.command == "backup":
        require_root()
        target = args.target or BACKUPS / datetime.now(timezone.utc).strftime("manual-%Y%m%dT%H%M%SZ") / "data.sqlite"
        manifest = backup_database(args.source, target)
        write_json(target.parent / "manifest.json", manifest)
        print(json.dumps(manifest, indent=2))
    elif args.command == "update":
        print(json.dumps(prepare_candidate(fetch=not args.no_fetch, portal_from=args.portal_from), indent=2))
    elif args.command == "promote":
        print(json.dumps(promote(args.confirm_cutover), indent=2))
    elif args.command == "rollback":
        rollback(args.confirm_rollback, args.restore_backup)
    elif args.command == "cleanup":
        cleanup(args.apply)
    elif args.command == "status":
        status()
    elif args.command == "watchdog":
        watchdog()
    elif args.command == "stop-candidate":
        require_root()
        stop_candidate()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
