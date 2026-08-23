import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
