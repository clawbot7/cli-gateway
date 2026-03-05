#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

STATE_DIR="${GUARD_STATE_DIR:-${PROJECT_ROOT}/.run-guard}"
REQ_FILE="${STATE_DIR}/restart.request"
BUSY_FILE="${STATE_DIR}/restart.busy"
COOLDOWN_SECONDS="${RESTART_REQUEST_COOLDOWN_SECONDS:-10}"
PROCESSING_FILE="${REQ_FILE}.processing.$$"

if ! [[ "${COOLDOWN_SECONDS}" =~ ^[0-9]+$ ]]; then
  COOLDOWN_SECONDS=10
fi

mkdir -p "${STATE_DIR}"

last_restart_ts=0

cleanup_busy() {
  rm -f "${BUSY_FILE}"
}

trap cleanup_busy EXIT INT TERM

echo "[watcher] watching ${REQ_FILE}"
echo "[watcher] cooldown=${COOLDOWN_SECONDS}s"

while true; do
  if [[ -f "${REQ_FILE}" && ! -f "${BUSY_FILE}" ]]; then
    now="$(date +%s)"

    if (( now - last_restart_ts < COOLDOWN_SECONDS )); then
      echo "[watcher] request ignored (cooldown)"
      rm -f "${REQ_FILE}"
    else
      touch "${BUSY_FILE}"

      if mv "${REQ_FILE}" "${PROCESSING_FILE}" 2>/dev/null; then
        echo "[watcher] restart requested at $(date -Iseconds)"
        bash "${PROJECT_ROOT}/scripts/run-guard.sh" restart || true
      fi

      rm -f "${PROCESSING_FILE}" "${BUSY_FILE}"
      last_restart_ts="${now}"
    fi
  fi

  sleep 1
done
