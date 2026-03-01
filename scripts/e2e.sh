#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_ENV_FILE="$ROOT_DIR/.env.e2e.local"
TYPO_ENV_FILE="$ROOT_DIR/.evn.e2e.local"

load_local_env() {
  local line key value

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue

    line="${line#export }"
    key="${line%%=*}"
    value="${line#*=}"

    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ -z "${!key+x}" ]] || continue

    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    export "$key=$value"
  done < "$LOCAL_ENV_FILE"
}

if [[ -f "$LOCAL_ENV_FILE" ]]; then
  load_local_env
elif [[ -f "$TYPO_ENV_FILE" ]]; then
  echo "Found .evn.e2e.local, but the expected file name is .env.e2e.local."
  exit 1
fi

# Edit the values below, export them before running this script, or put them in
# .env.e2e.local. The local env file is ignored by git.
export RAGBOX_E2E="${RAGBOX_E2E:-1}"
export RAGBOX_VERBOSE="${RAGBOX_VERBOSE:-1}"
export RAGBOX_E2E_VERBOSE="${RAGBOX_E2E_VERBOSE:-1}"
export PAGEINDEX_CLI="${PAGEINDEX_CLI:-/path/to/PageIndex/run_pageindex.py}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-...}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}"
export PAGEINDEX_MODEL="${PAGEINDEX_MODEL:-gpt-4o-mini}"
export RAGBOX_E2E_QUERY_MODEL="${RAGBOX_E2E_QUERY_MODEL:-gpt-4o-mini}"
export RAGBOX_E2E_DOCS_DIR="${RAGBOX_E2E_DOCS_DIR:-./examples}"
export RAGBOX_E2E_OUTPUT_DIR="${RAGBOX_E2E_OUTPUT_DIR:-${RAGBOX_E2E_DOCS_DIR%/}/.pageindex}"
export RAGBOX_E2E_EXPECTED_TEXT="${RAGBOX_E2E_EXPECTED_TEXT:-PKCE}"
export RAGBOX_E2E_TIMEOUT_MS="${RAGBOX_E2E_TIMEOUT_MS:-900000}"
export RAGBOX_E2E_COMMAND_TIMEOUT_MS="${RAGBOX_E2E_COMMAND_TIMEOUT_MS:-300000}"
export RAGBOX_E2E_HEARTBEAT_MS="${RAGBOX_E2E_HEARTBEAT_MS:-10000}"

if [[ "${RAGBOX_E2E_EXPECTED_TEXT:-}" == "ORIGINAL_RANDOM_VERIFIER" ]]; then
  export RAGBOX_E2E_EXPECTED_TEXT="PKCE"
fi

if [[ "${RAGBOX_E2E_QUESTION:-}" == *"ORIGINAL_RANDOM_VERIFIER"* ]]; then
  export RAGBOX_E2E_QUESTION="What problem does PKCE solve in OAuth 2.0, and how does it reduce authorization code interception risk? Cite the source."
fi

if [[ "${RAGBOX_E2E_QUESTION:-}" == *"认证里那个 PKCE"* ]]; then
  export RAGBOX_E2E_QUESTION="What problem does PKCE solve in OAuth 2.0, and how does it reduce authorization code interception risk? Cite the source."
fi

# Optional examples:
# export PAGEINDEX_OUTPUT_ARG="${PAGEINDEX_OUTPUT_ARG:---output}"
# export RAGBOX_E2E_PAGEINDEX_PYTHON="${RAGBOX_E2E_PAGEINDEX_PYTHON:-/path/to/python}"
# export RAGBOX_E2E_QUESTION="${RAGBOX_E2E_QUESTION:-What problem does PKCE solve in OAuth 2.0, and how does it reduce authorization code interception risk? Cite the source.}"

if [[ "$RAGBOX_E2E" != "1" ]]; then
  echo "RAGBOX_E2E=$RAGBOX_E2E, running e2e test in skip mode."
  cd "$ROOT_DIR"
  npm run test:e2e:raw
  exit 0
fi

if [[ "$PAGEINDEX_CLI" == "/path/to/PageIndex/run_pageindex.py" ]]; then
  echo "Please set PAGEINDEX_CLI to your real PageIndex script path."
  echo "Example: PAGEINDEX_CLI=/opt/PageIndex/run_pageindex.py bash scripts/e2e.sh"
  exit 1
fi

if [[ "$PAGEINDEX_CLI" != /* ]]; then
  PAGEINDEX_CLI="$ROOT_DIR/$PAGEINDEX_CLI"
  export PAGEINDEX_CLI
fi

if [[ ! -f "$PAGEINDEX_CLI" ]]; then
  echo "PAGEINDEX_CLI does not exist: $PAGEINDEX_CLI"
  exit 1
fi

API_KEY_FOR_CHECK="${RAGBOX_E2E_API_KEY:-$OPENAI_API_KEY}"
if [[ -z "$API_KEY_FOR_CHECK" || "$API_KEY_FOR_CHECK" == "sk-..." ]]; then
  echo "Please set OPENAI_API_KEY or RAGBOX_E2E_API_KEY to a real API key."
  exit 1
fi

echo "Running real ragbox e2e test..."
if [[ "$OPENAI_BASE_URL" == */chat/completions || "$OPENAI_BASE_URL" == */chat/completions/ ]]; then
  echo "OPENAI_BASE_URL points to a full chat completions endpoint. A root URL ending at /v1 is recommended, but ragbox query will use this endpoint as-is."
fi
echo "RAGBOX_VERBOSE=$RAGBOX_VERBOSE"
echo "PAGEINDEX_CLI=$PAGEINDEX_CLI"
echo "PAGEINDEX_PYTHON=${RAGBOX_E2E_PAGEINDEX_PYTHON:-${PAGEINDEX_PYTHON:-python3}}"
echo "OPENAI_BASE_URL=$OPENAI_BASE_URL"
echo "PAGEINDEX_MODEL=$PAGEINDEX_MODEL"
echo "RAGBOX_E2E_QUERY_MODEL=$RAGBOX_E2E_QUERY_MODEL"
echo "RAGBOX_E2E_QUESTION=${RAGBOX_E2E_QUESTION:-What problem does PKCE solve in OAuth 2.0, and how does it reduce authorization code interception risk? Cite the source.}"
echo "RAGBOX_E2E_EXPECTED_TEXT=$RAGBOX_E2E_EXPECTED_TEXT"
echo "RAGBOX_E2E_DOCS_DIR=$RAGBOX_E2E_DOCS_DIR"
echo "RAGBOX_E2E_OUTPUT_DIR=$RAGBOX_E2E_OUTPUT_DIR"
echo "RAGBOX_E2E_TIMEOUT_MS=$RAGBOX_E2E_TIMEOUT_MS"
echo "RAGBOX_E2E_COMMAND_TIMEOUT_MS=$RAGBOX_E2E_COMMAND_TIMEOUT_MS"
echo "RAGBOX_E2E_HEARTBEAT_MS=$RAGBOX_E2E_HEARTBEAT_MS"

cd "$ROOT_DIR"
npm run test:e2e:raw
