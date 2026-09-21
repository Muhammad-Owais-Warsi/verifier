#!/bin/bash
# Grades /app with the verifier. Harbor copies this directory to /tests after the
# agent has stopped, so nothing in here exists while the agent is working.
set -uo pipefail

mkdir -p /logs/verifier
echo 0 > /logs/verifier/reward.txt

cp -r /tests/verifier /tests/tasks /opt/toolchain/
cd /opt/toolchain

./node_modules/.bin/tsx verifier/run.ts /app image-process

node -e '
  const fs = require("node:fs");
  const report = JSON.parse(fs.readFileSync("/opt/toolchain/results/report.json", "utf8"));
  fs.writeFileSync("/logs/verifier/reward.txt", String(report.score.total));
  fs.copyFileSync("/opt/toolchain/results/report.json", "/logs/verifier/report.json");
'
