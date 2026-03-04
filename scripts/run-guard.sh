#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

STATE_DIR="${GUARD_STATE_DIR:-${PROJECT_ROOT}/.run-guard}"
PID_FILE="${STATE_DIR}/guard.pid"
APP_PID_FILE="${STATE_DIR}/app.pid"
CMD_FILE="${STATE_DIR}/command.args"
LOG_FILE="${STATE_DIR}/guard.log"

BASE_DELAY="${RESTART_BASE_DELAY_SECONDS:-2}"
MAX_DELAY="${RESTART_MAX_DELAY_SECONDS:-30}"
MAX_ATTEMPTS="${RESTART_MAX_ATTEMPTS:-0}"
RESTART_ON_EXIT_0="${RESTART_ON_EXIT_0:-0}"
STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-20}"
SKIP_UPDATE="${SKIP_UPDATE:-0}"
LOG_TAIL_LINES="${LOG_TAIL_LINES:-120}"

DEFAULT_CMD=("node" "dist/main.js")
RESOLVED_CMD=()

expand_home_path() {
  local raw="$1"

  if [[ "${raw}" == "~" ]]; then
    printf '%s\n' "${HOME}"
    return
  fi

  if [[ "${raw}" == "~/"* ]]; then
    printf '%s/%s\n' "${HOME}" "${raw#~/}"
    return
  fi

  printf '%s\n' "${raw}"
}

resolve_gateway_lock_file() {
  local gateway_home_raw="${CLI_GATEWAY_HOME:-${HOME}/.cli-gateway}"
  local gateway_home

  gateway_home="$(expand_home_path "${gateway_home_raw}")"
  printf '%s/gateway.lock\n' "${gateway_home%/}"
}

ensure_state_dir() {
  mkdir -p "${STATE_DIR}"
}

is_running_pid() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

read_lock_pid() {
  local file="$1"
  local pid

  [[ -f "${file}" ]] || return 1

  pid="$(grep -Eo '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "${file}" | head -n 1 | grep -Eo '[0-9]+' || true)"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1

  printf '%s\n' "${pid}"
}

terminate_pid() {
  local pid="$1"
  local label="${2:-process}"
  local waited=0

  if ! is_running_pid "${pid}"; then
    return 0
  fi

  echo "[guard] stopping ${label} pid=${pid}"
  kill "${pid}" 2>/dev/null || true

  while is_running_pid "${pid}" && [[ "${waited}" -lt "${STOP_TIMEOUT_SECONDS}" ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  if is_running_pid "${pid}"; then
    echo "[guard] ${label} still alive, forcing kill"
    kill -9 "${pid}" 2>/dev/null || true
  fi
}

cleanup_gateway_lock() {
  local lock_file
  local pid

  lock_file="$(resolve_gateway_lock_file)"
  [[ -f "${lock_file}" ]] || return 0

  echo "[guard] lock file detected: ${lock_file}"

  if pid="$(read_lock_pid "${lock_file}" 2>/dev/null || true)"; then
    if is_running_pid "${pid}"; then
      terminate_pid "${pid}" "gateway(lock)"
    else
      echo "[guard] lock pid is not running pid=${pid}, removing stale lock"
    fi
  else
    echo "[guard] lock pid parse failed, removing lock"
  fi

  rm -f "${lock_file}"
}

read_pid_file() {
  local file="$1"
  local pid

  [[ -f "${file}" ]] || return 1
  pid="$(<"${file}")"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1

  printf '%s\n' "${pid}"
}

current_guard_pid() {
  local pid

  if pid="$(read_pid_file "${PID_FILE}")" && is_running_pid "${pid}"; then
    printf '%s\n' "${pid}"
    return 0
  fi

  return 1
}

read_app_pid() {
  local pid

  if pid="$(read_pid_file "${APP_PID_FILE}")" && is_running_pid "${pid}"; then
    printf '%s\n' "${pid}"
    return 0
  fi

  return 1
}

cleanup_stale_files() {
  local pid

  if pid="$(read_pid_file "${PID_FILE}" 2>/dev/null || true)"; then
    if ! is_running_pid "${pid}"; then
      rm -f "${PID_FILE}" "${APP_PID_FILE}"
    fi
  fi

  if pid="$(read_pid_file "${APP_PID_FILE}" 2>/dev/null || true)"; then
    if ! is_running_pid "${pid}"; then
      rm -f "${APP_PID_FILE}"
    fi
  fi
}

save_command() {
  local arg

  ensure_state_dir
  : > "${CMD_FILE}"

  for arg in "$@"; do
    printf '%s\n' "${arg}" >> "${CMD_FILE}"
  done
}

resolve_command() {
  local -a loaded=()

  if [[ $# -gt 0 ]]; then
    RESOLVED_CMD=("$@")
    return
  fi

  if [[ -f "${CMD_FILE}" ]]; then
    mapfile -t loaded < "${CMD_FILE}"
    if [[ ${#loaded[@]} -gt 0 ]]; then
      RESOLVED_CMD=("${loaded[@]}")
      return
    fi
  fi

  RESOLVED_CMD=("${DEFAULT_CMD[@]}")
}

run_update() {
  if [[ "${SKIP_UPDATE}" == "1" ]]; then
    echo "[guard] skip update/build (SKIP_UPDATE=1)"
    return
  fi

  echo "[guard] running: npm i"
  (
    cd "${PROJECT_ROOT}"
    npm i
  )

  echo "[guard] running: npm run build"
  (
    cd "${PROJECT_ROOT}"
    npm run build
  )
}

start_guard() {
  local -a cmd=("$@")
  local guard_pid

  ensure_state_dir
  cleanup_stale_files

  if guard_pid="$(current_guard_pid)"; then
    echo "[guard] already running pid=${guard_pid}"
    echo "[guard] log: ${LOG_FILE}"
    return 0
  fi

  cleanup_gateway_lock

  resolve_command "${cmd[@]}"
  cmd=("${RESOLVED_CMD[@]}")
  save_command "${cmd[@]}"

  run_update

  echo "[guard] starting in background: ${cmd[*]}"
  echo "[guard] log file: ${LOG_FILE}"

  (
    cd "${PROJECT_ROOT}"
    nohup bash "${SCRIPT_DIR}/run-guard.sh" _run-loop -- "${cmd[@]}" >> "${LOG_FILE}" 2>&1 &
    echo "$!" > "${PID_FILE}"
  )

  guard_pid="$(<"${PID_FILE}")"
  sleep 1

  if ! is_running_pid "${guard_pid}"; then
    rm -f "${PID_FILE}"
    echo "[guard] failed to start, check log: ${LOG_FILE}" >&2
    return 1
  fi

  echo "[guard] started pid=${guard_pid}"
}

stop_guard() {
  local guard_pid
  local app_pid
  local waited=0

  ensure_state_dir
  cleanup_stale_files

  if ! guard_pid="$(current_guard_pid)"; then
    rm -f "${PID_FILE}" "${APP_PID_FILE}"
    echo "[guard] not running"
    return 0
  fi

  echo "[guard] stopping guard pid=${guard_pid}"
  kill "${guard_pid}" 2>/dev/null || true

  while is_running_pid "${guard_pid}" && [[ "${waited}" -lt "${STOP_TIMEOUT_SECONDS}" ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  if is_running_pid "${guard_pid}"; then
    echo "[guard] guard still alive, forcing kill"
    kill -9 "${guard_pid}" 2>/dev/null || true
  fi

  if app_pid="$(read_app_pid)"; then
    terminate_pid "${app_pid}" "app"
  fi

  cleanup_gateway_lock

  rm -f "${PID_FILE}" "${APP_PID_FILE}"
  echo "[guard] stopped"
}

restart_guard() {
  local -a cmd=("$@")

  stop_guard
  start_guard "${cmd[@]}"
}

status_guard() {
  local guard_pid
  local app_pid

  ensure_state_dir
  cleanup_stale_files

  if guard_pid="$(current_guard_pid)"; then
    echo "[guard] status: running"
    echo "[guard] guard pid: ${guard_pid}"
    if app_pid="$(read_app_pid)"; then
      echo "[guard] app pid: ${app_pid}"
    else
      echo "[guard] app pid: unavailable (starting/restarting)"
    fi
    echo "[guard] log: ${LOG_FILE}"
    return 0
  fi

  echo "[guard] status: stopped"
  echo "[guard] log: ${LOG_FILE}"
  return 1
}

logs_guard() {
  local mode="${1:-}"

  ensure_state_dir

  if [[ ! -f "${LOG_FILE}" ]]; then
    echo "[guard] log file not found: ${LOG_FILE}"
    return 1
  fi

  if [[ "${mode}" == "-f" || "${mode}" == "--follow" ]]; then
    tail -n "${LOG_TAIL_LINES}" -f "${LOG_FILE}"
    return
  fi

  tail -n "${LOG_TAIL_LINES}" "${LOG_FILE}"
}

run_loop() {
  local -a cmd=("$@")
  local attempt=0
  local child_pid=""

  ensure_state_dir
  resolve_command "${cmd[@]}"
  cmd=("${RESOLVED_CMD[@]}")

  echo "$$" > "${PID_FILE}"

  on_signal() {
    echo "[guard] stop signal received"
    if [[ -n "${child_pid}" ]] && is_running_pid "${child_pid}"; then
      kill "${child_pid}" 2>/dev/null || true
      wait "${child_pid}" 2>/dev/null || true
    fi
    rm -f "${APP_PID_FILE}" "${PID_FILE}"
    exit 0
  }

  trap on_signal TERM INT

  echo "[guard] command: ${cmd[*]}"
  echo "[guard] base_delay=${BASE_DELAY}s max_delay=${MAX_DELAY}s max_attempts=${MAX_ATTEMPTS}"

  while true; do
    local start_at
    local ended_at
    local exit_code
    local delay

    start_at="$(date '+%Y-%m-%d %H:%M:%S %z')"
    cleanup_gateway_lock
    echo "[guard] starting at ${start_at}"

    (
      cd "${PROJECT_ROOT}"
      "${cmd[@]}"
    ) &
    child_pid="$!"
    echo "${child_pid}" > "${APP_PID_FILE}"

    set +e
    wait "${child_pid}"
    exit_code=$?
    set -e

    child_pid=""
    rm -f "${APP_PID_FILE}"

    ended_at="$(date '+%Y-%m-%d %H:%M:%S %z')"
    echo "[guard] process exited code=${exit_code} at ${ended_at}"

    if [[ "${exit_code}" -eq 0 && "${RESTART_ON_EXIT_0}" != "1" ]]; then
      echo "[guard] clean exit, not restarting"
      rm -f "${PID_FILE}"
      exit 0
    fi

    attempt=$((attempt + 1))

    if [[ "${MAX_ATTEMPTS}" -gt 0 && "${attempt}" -gt "${MAX_ATTEMPTS}" ]]; then
      echo "[guard] restart limit reached (${MAX_ATTEMPTS}), giving up"
      rm -f "${PID_FILE}"
      exit "${exit_code}"
    fi

    delay=$((BASE_DELAY * (2 ** (attempt - 1))))
    if [[ "${delay}" -gt "${MAX_DELAY}" ]]; then
      delay="${MAX_DELAY}"
    fi

    echo "[guard] restarting in ${delay}s (attempt=${attempt})"
    sleep "${delay}"
  done
}

usage() {
  cat <<'EOF_USAGE'
Usage:
  bash scripts/run-guard.sh [start] [-- <command...>]
  bash scripts/run-guard.sh stop
  bash scripts/run-guard.sh restart [-- <command...>]
  bash scripts/run-guard.sh status
  bash scripts/run-guard.sh logs [-f]

Notes:
  - `start`/`restart` will run `npm i` and `npm run build` before launching.
  - Default command is `node dist/main.js`.
  - Legacy form `bash scripts/run-guard.sh npm run dev` is still supported.

Useful env vars:
  RESTART_BASE_DELAY_SECONDS (default: 2)
  RESTART_MAX_DELAY_SECONDS (default: 30)
  RESTART_MAX_ATTEMPTS (default: 0, unlimited)
  RESTART_ON_EXIT_0 (default: 0)
  STOP_TIMEOUT_SECONDS (default: 20)
  SKIP_UPDATE=1 to skip npm i/build
  GUARD_STATE_DIR to change pid/log directory
EOF_USAGE
}

is_known_action() {
  case "$1" in
    start|stop|restart|status|logs|help|_run-loop)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

main() {
  local action="${1:-start}"
  local -a args=()

  if is_known_action "${action}"; then
    shift || true
    args=("$@")
  else
    action="start"
    args=("$@")
  fi

  if [[ ${#args[@]} -gt 0 && "${args[0]}" == "--" ]]; then
    args=("${args[@]:1}")
  fi

  case "${action}" in
    start)
      start_guard "${args[@]}"
      ;;
    stop)
      stop_guard
      ;;
    restart)
      restart_guard "${args[@]}"
      ;;
    status)
      status_guard
      ;;
    logs)
      logs_guard "${args[@]}"
      ;;
    help)
      usage
      ;;
    _run-loop)
      run_loop "${args[@]}"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
