import importlib.util
import json
import sqlite3
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("nine_router_ctl", ROOT / "ops/9routerctl.py")
CTL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CTL)


class OpsTests(unittest.TestCase):
    def test_online_backup_is_complete_and_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.sqlite"
            target = Path(tmp) / "backup.sqlite"
            db = sqlite3.connect(source)
            db.executescript("""
                create table _meta(key text primary key, value text not null);
                create table usageHistory(id integer primary key, value text);
                insert into _meta values('schemaVersion', '1');
                insert into usageHistory values(1, 'kept');
            """)
            db.commit()
            db.close()

            manifest = CTL.backup_database(source, target)

            copy = sqlite3.connect(f"file:{target}?mode=ro", uri=True)
            self.assertEqual(copy.execute("pragma quick_check").fetchone()[0], "ok")
            self.assertEqual(copy.execute("select value from usageHistory").fetchone()[0], "kept")
            copy.close()
            self.assertEqual(manifest["schemaVersion"], "1")
            self.assertEqual(len(manifest["sha256"]), 64)

    def test_candidate_sanitization_disables_background_side_effects(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            db = sqlite3.connect(database)
            db.executescript("""
                create table settings(id integer primary key, data text not null);
                insert into settings values(1, '{"tunnelEnabled":true,"mitmEnabled":true}');
            """)
            db.commit()
            db.close()

            CTL.sanitize_candidate(database)

            db = sqlite3.connect(database)
            settings = json.loads(db.execute("select data from settings where id=1").fetchone()[0])
            db.close()
            for key in ("cloudEnabled", "tunnelEnabled", "tailscaleEnabled", "mitmEnabled"):
                self.assertFalse(settings[key])

    def test_container_contract_is_hardened(self):
        args = CTL.container_security_args()
        joined = " ".join(args)
        for required in (
            "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges",
            "--restart always", "--log-opt max-size=20m", "--log-opt max-file=5",
        ):
            self.assertIn(required, joined)

    def test_live_permissions_precreate_viewer_session_secret_without_exposing_ops(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_data = CTL.LIVE_DATA
            CTL.LIVE_DATA = Path(tmp)
            (Path(tmp) / "ops").mkdir()
            watchdog = Path(tmp) / "ops/watchdog.sh"
            watchdog.write_text("root-owned")
            os.chmod(watchdog, 0o755)
            try:
                CTL.prepare_live_permissions()
                secret = Path(tmp) / "fork-viewer-portal-jwt-secret"
                self.assertTrue(secret.exists())
                self.assertEqual(secret.stat().st_mode & 0o777, 0o600)
                self.assertEqual(watchdog.stat().st_uid, 0)
                self.assertEqual(Path(tmp).stat().st_uid, 0)
            finally:
                CTL.LIVE_DATA = old_data

    def test_restore_keeps_failed_database_and_atomically_installs_verified_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_data, old_backups = CTL.LIVE_DATA, CTL.BACKUPS
            CTL.LIVE_DATA, CTL.BACKUPS = Path(tmp) / "live", Path(tmp) / "backups"
            db_dir = CTL.LIVE_DATA / "db"
            db_dir.mkdir(parents=True)
            live = db_dir / "data.sqlite"
            backup = Path(tmp) / "good.sqlite"
            for path, value in ((live, "new"), (backup, "old")):
                db = sqlite3.connect(path)
                db.execute("create table state(value text)")
                db.execute("insert into state values(?)", (value,))
                db.commit(); db.close()
            try:
                CTL.restore_database(backup)
                db = sqlite3.connect(live)
                self.assertEqual(db.execute("select value from state").fetchone()[0], "old")
                db.close()
                failed = list(CTL.BACKUPS.glob("failed-*/data.sqlite"))
                self.assertEqual(len(failed), 1)
                db = sqlite3.connect(failed[0])
                self.assertEqual(db.execute("select value from state").fetchone()[0], "new")
                db.close()
            finally:
                CTL.LIVE_DATA, CTL.BACKUPS = old_data, old_backups

    def test_stop_legacy_waits_for_timer_service_app_and_open_database(self):
        calls = []
        with patch.object(CTL, "systemctl", side_effect=lambda *args, **kwargs: calls.append(args)), \
             patch.object(CTL, "is_active", return_value=True), \
             patch.object(CTL, "wait_port_free") as port_free, \
             patch.object(CTL, "wait_database_closed") as database_closed:
            CTL.stop_legacy()
        self.assertIn(("stop", "9router-watchdog.timer", "9router-watchdog.service"), calls)
        self.assertIn(("stop", "9router.service"), calls)
        port_free.assert_called_once_with(20128)
        database_closed.assert_called_once()

    def test_promotion_requires_explicit_portal_transfer_approval(self):
        args = CTL.parser().parse_args(["promote", "--confirm-cutover", "--apply-candidate-portal-config"])
        self.assertTrue(args.apply_candidate_portal_config)

    def test_portal_transfer_requires_approval_and_valid_api_key_references(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / "candidate.sqlite", Path(tmp) / "live.sqlite"
            portal = {"enabled": True, "groups": [{"id": "g", "name": "Group", "apiKeyIds": ["key-1"]}]}
            for path, settings in (
                (source, {"forkExtensions": {"viewerPortal": portal}}),
                (target, {"unrelated": "preserved"}),
            ):
                db = sqlite3.connect(path)
                db.execute("create table settings(id integer primary key, data text not null)")
                db.execute("create table apiKeys(id text primary key)")
                db.execute("insert into apiKeys values('key-1')")
                db.execute("insert into settings values(1, ?)", (json.dumps(settings),))
                db.commit(); db.close()

            with self.assertRaisesRegex(RuntimeError, "--apply-candidate-portal-config"):
                CTL.apply_portal_config(source, target, approved=False)
            result = CTL.apply_portal_config(source, target, approved=True)
            self.assertNotEqual(result["before"], result["after"])
            db = sqlite3.connect(target)
            stored = json.loads(db.execute("select data from settings where id=1").fetchone()[0])
            db.close()
            self.assertEqual(stored["unrelated"], "preserved")
            self.assertEqual(stored["forkExtensions"]["viewerPortal"], portal)

    def test_portal_transfer_rejects_missing_api_key_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / "candidate.sqlite", Path(tmp) / "live.sqlite"
            for path, portal in ((source, {"groups": [{"apiKeyIds": ["missing"]}]}), (target, None)):
                db = sqlite3.connect(path)
                db.execute("create table settings(id integer primary key, data text not null)")
                db.execute("create table apiKeys(id text primary key)")
                settings = {"forkExtensions": {"viewerPortal": portal}} if portal else {}
                db.execute("insert into settings values(1, ?)", (json.dumps(settings),))
                db.commit(); db.close()
            with self.assertRaisesRegex(RuntimeError, "unknown API key"):
                CTL.apply_portal_config(source, target, approved=True)

    def test_release_state_is_one_atomic_source_of_truth(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_releases = CTL.RELEASES
            CTL.RELEASES = Path(tmp)
            try:
                CTL.write_release_state({"kind": "image", "imageId": "new"}, {"kind": "systemd"})
                current, previous = CTL.release_state()
                self.assertEqual(current["imageId"], "new")
                self.assertEqual(previous["kind"], "systemd")
                self.assertTrue((Path(tmp) / "state.json").exists())
                self.assertFalse((Path(tmp) / "current.json").exists())
                self.assertFalse((Path(tmp) / "previous.json").exists())
            finally:
                CTL.RELEASES = old_releases

    def test_release_schema_reads_live_metadata_before_snapshot_metadata(self):
        self.assertEqual(CTL.release_schema({
            "schemaVersion": "old", "database": {"schemaVersion": "candidate"},
            "liveDatabase": {"schemaVersion": "live"},
        }), "live")

    def test_failed_promotion_stops_writer_restores_backup_then_restarts_previous(self):
        calls = []
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(CTL, "stop_all_writers", side_effect=lambda: calls.append("stop")), \
             patch.object(CTL, "restore_database", side_effect=lambda path: calls.append(("restore", path))), \
             patch.object(CTL, "start_release", side_effect=lambda release: calls.append(("start", release))):
            backup = Path(tmp)
            (backup / "data.sqlite").touch()
            previous = {"kind": "systemd"}
            CTL.recover_release(previous, backup)
        self.assertEqual(calls, ["stop", ("restore", backup), ("start", previous)])

    def test_candidate_finalization_freezes_wal_aware_database_and_removes_mutable_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "candidate" / "data"
            data.joinpath("db").mkdir(parents=True)
            database = data / "db/data.sqlite"
            db = sqlite3.connect(database)
            db.execute("pragma journal_mode=wal")
            db.execute("create table state(value text)")
            db.execute("insert into state values('tested')")
            db.commit(); db.close()
            candidate = {"data": str(data), "imageId": "sha256:image", "healthPassedAt": "now"}
            with patch.object(CTL, "docker_exists", return_value=False), \
                 patch.object(CTL, "remove_container"), \
                 patch.object(CTL, "wait_database_closed"):
                frozen = CTL.finalize_candidate(candidate)
            artifact = Path(frozen["finalizedDatabase"])
            self.assertTrue(artifact.exists())
            self.assertFalse(data.exists())
            self.assertEqual(CTL.inspect_database(artifact)["sha256"], frozen["database"]["sha256"])
            db = sqlite3.connect(artifact)
            self.assertEqual(db.execute("select value from state").fetchone()[0], "tested")
            db.close()

    def test_database_close_check_fails_closed_when_lsof_errors(self):
        completed = type("Result", (), {"returncode": 2, "stdout": "", "stderr": "failure"})()
        with patch.object(CTL, "run", return_value=completed):
            with self.assertRaisesRegex(RuntimeError, "lsof failed"):
                CTL.wait_database_closed(timeout=0.01)


if __name__ == "__main__":
    unittest.main()
