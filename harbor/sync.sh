#!/bin/bash
# Copies the verifier, the video-transcode expectations and the two brief files
# into the Harbor task, byte for byte. The originals stay the source of truth.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
task="$repo/harbor/video-encoder"

rm -rf "$task/tests/verifier" "$task/tests/tasks"
mkdir -p "$task/tests/tasks/video-transcode"

cp -r "$repo/verifier" "$task/tests/verifier"
cp "$repo/tasks/video-transcode/expectations.json" "$task/tests/tasks/video-transcode/expectations.json"
cp "$repo/tasks/video-transcode/TASK.md" "$task/environment/TASK.md"
cp "$repo/tasks/setup.md" "$task/environment/setup.md"

echo "synced -> harbor/video-encoder"
