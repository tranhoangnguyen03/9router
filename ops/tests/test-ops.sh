#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -m py_compile ops/9routerctl.py
python3 ops/tests/test_ops.py
service=ops/systemd/9router-managed-watchdog.service
timer=ops/systemd/9router-managed-watchdog.timer
grep -q '^ExecStart=/opt/9router/bin/9routerctl watchdog$' "$service"
grep -q '^After=docker.service network-online.target$' "$service"
grep -q '^OnUnitActiveSec=60$' "$timer"
grep -q '^WantedBy=timers.target$' "$timer"
echo 'managed ops checks passed'
