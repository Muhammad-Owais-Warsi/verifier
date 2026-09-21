#!/bin/bash
# Copies the verifier, a task's expectations and the two brief files into each
# Harbor task, byte for byte. The originals stay the source of truth.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# sync <task name under tasks/> <folder under harbor/>
sync() {
  local name="$1"
  local task="$repo/harbor/$2"

  rm -rf "$task/tests/verifier" "$task/tests/tasks"
  mkdir -p "$task/tests/tasks/$name"

  cp -r "$repo/verifier" "$task/tests/verifier"
  cp "$repo/tasks/$name/expectations.json" "$task/tests/tasks/$name/expectations.json"
  cp "$repo/tasks/$name/TASK.md" "$task/environment/TASK.md"
  cp "$repo/tasks/setup.md" "$task/environment/setup.md"

  echo "synced -> harbor/$2"
}

sync video-transcode video-encoder
sync driving-license driving-license
sync image-process image-process
