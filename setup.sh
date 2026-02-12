#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
DEFAULT_IMAGE="${OPENCLAW_IMAGE:-openclaw:local}"
cd "$ROOT_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing dependency: %s\n' "$1" >&2
    exit 1
  fi
}

require_compose() {
  if ! docker compose version >/dev/null 2>&1; then
    printf 'Docker Compose v2 is required (`docker compose version`)\n' >&2
    exit 1
  fi
}

sanitize_project_name() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
  while [[ "$value" == -* ]]; do
    value="${value#-}"
  done
  while [[ "$value" == *- ]]; do
    value="${value%-}"
  done
  printf '%s' "$value"
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
    return
  fi

  printf 'Need either openssl or python3 to generate a gateway token\n' >&2
  exit 1
}

build_or_verify_image() {
  local image="$1"
  local source_path="$2"

  if [ -n "$source_path" ]; then
    if [ ! -d "$source_path" ]; then
      printf 'OpenClaw source path does not exist: %s\n' "$source_path" >&2
      exit 1
    fi
    if [ ! -f "$source_path/Dockerfile" ]; then
      printf 'No Dockerfile found at: %s\n' "$source_path" >&2
      exit 1
    fi

    printf '\n==> Building Docker image: %s\n' "$image"
    docker build -t "$image" -f "$source_path/Dockerfile" "$source_path"
    return
  fi

  if ! docker image inspect "$image" >/dev/null 2>&1; then
    printf 'Image %s not found. Provide OpenClaw source path to build it.\n' "$image" >&2
    exit 1
  fi
}

write_env_file() {
  local compose_project_name="$1"
  local image="$2"
  local gateway_host="$3"
  local gateway_token="$4"
  local config_dir="$ROOT_DIR/.openclaw"
  local workspace_dir="$ROOT_DIR/.openclaw/workspace"
  local tmp_env

  mkdir -p "$config_dir" "$workspace_dir"

  umask 077
  tmp_env="$(mktemp)"

  cat >"$tmp_env" <<EOF
COMPOSE_PROJECT_NAME=$compose_project_name
OPENCLAW_IMAGE=$image
OPENCLAW_CONFIG_DIR=./.openclaw
OPENCLAW_WORKSPACE_DIR=./.openclaw/workspace
OPENCLAW_GATEWAY_HOST=$gateway_host
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_GATEWAY_TOKEN=$gateway_token
EOF

  mv "$tmp_env" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

require_cmd docker
require_compose
if ! docker info >/dev/null 2>&1; then
  printf 'Docker daemon is not reachable. Start Docker and retry.\n' >&2
  exit 1
fi

printf '==> OpenClaw Agent Setup\n'

read -r -p 'Agent name [openclaw-agent]: ' agent_name
agent_name="${agent_name:-openclaw-agent}"
compose_project_name="$(sanitize_project_name "$agent_name")"
if [ -z "$compose_project_name" ]; then
  compose_project_name="openclaw-agent"
fi

read -r -p 'OpenClaw source path to build image (leave empty to skip build): ' openclaw_source
if [[ "$openclaw_source" == ~* ]]; then
  openclaw_source="$HOME${openclaw_source#\~}"
fi
read -r -p "Docker image tag [$DEFAULT_IMAGE]: " image_name
image_name="${image_name:-$DEFAULT_IMAGE}"

read -r -p 'Expose gateway on all interfaces (0.0.0.0)? [y/N]: ' network_access
if [[ "$network_access" =~ ^[Yy]$ ]]; then
  gateway_host="0.0.0.0"
else
  gateway_host="127.0.0.1"
fi

if [ -f "$ENV_FILE" ]; then
  read -r -p '.env already exists. Overwrite it? [y/N]: ' overwrite
  if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
    printf 'Setup cancelled. Existing .env was left untouched.\n'
    exit 0
  fi
fi

gateway_token="$(generate_token)"

build_or_verify_image "$image_name" "$openclaw_source"
write_env_file "$compose_project_name" "$image_name" "$gateway_host" "$gateway_token"

printf '\n==> Provider & model setup (interactive)\n'
printf 'The onboarding wizard will guide you through:\n'
printf '  - Choosing a model provider (Anthropic, OpenAI, Google, etc.)\n'
printf '  - Setting up authentication (API key, OAuth, or setup-token)\n'
printf '  - Picking your default model\n'
printf '  - Configuring chat channels (Telegram, WhatsApp, etc.)\n\n'

docker compose --profile cli run --rm cli onboard --no-install-daemon

printf '\n==> Starting gateway\n'
docker compose up -d gateway

printf '\nYour OpenClaw agent is running.\n\n'
printf 'Commands:\n'
printf '  make logs     - Follow agent logs\n'
printf '  make status   - Check agent status\n'
printf '  make stop     - Stop the agent\n'
printf '  make shell    - Open shell in container\n\n'
printf 'Provider setup (add more later):\n'
printf "  make cli CMD='onboard'\n"
printf "  make cli CMD='channels add --channel telegram --token <token>'\n\n"
printf 'Docs: https://docs.openclaw.ai\n'
