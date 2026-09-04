#!/bin/sh
# Turn container environment variables into the one-time initial_auth.json that
# Rogue already knows how to import, then hand the process over to the agent.
#
# The environment is a provisioning input, not a second source of truth: it is
# consulted only until the agent has durable state of its own, after which the
# agent's stored credentials, routes, proxy, and relays win. Set
# ROGUE_REPROVISION=1 to deliberately re-apply the environment on a start.
set -eu

WORKSPACE=${ROGUE_WORKSPACE:-/home/rogue/agent}
BINARY=${ROGUE_BINARY:-/opt/rogue/rogue.js}
STATE_DIR="$WORKSPACE/.rogue"
BOOTSTRAP="$WORKSPACE/initial_auth.json"

note() { printf 'rogue-entrypoint: %s\n' "$1" >&2; }
fail() { note "$1"; exit 1; }

umask 077
mkdir -p "$WORKSPACE" "$STATE_DIR"
cd "$WORKSPACE"

provisioned=no
if [ -e "$STATE_DIR/config.json" ]; then provisioned=yes; fi

if [ "$provisioned" = yes ] && [ "${ROGUE_REPROVISION:-0}" != "1" ]; then
  note "existing state in $STATE_DIR — leaving the agent's own configuration alone"
else
  # A mounted file or a raw JSON variable is the base document; the individual
  # variables below are layered on top of it.
  if [ -n "${ROGUE_INITIAL_AUTH_FILE:-}" ]; then
    [ -r "$ROGUE_INITIAL_AUTH_FILE" ] || fail "ROGUE_INITIAL_AUTH_FILE ($ROGUE_INITIAL_AUTH_FILE) is not readable."
    document=$(jq '.' <"$ROGUE_INITIAL_AUTH_FILE") || fail "$ROGUE_INITIAL_AUTH_FILE is not valid JSON."
  elif [ -n "${ROGUE_INITIAL_AUTH:-}" ]; then
    document=$(printf '%s' "$ROGUE_INITIAL_AUTH" | jq '.') || fail "ROGUE_INITIAL_AUTH is not valid JSON."
  else
    document='{}'
  fi

  # Priorities step by ten and continue after whatever the base document already
  # listed, so the primary route is tried first and the fallback second. Keys
  # reach jq through the environment rather than through arguments, so no
  # credential is ever visible in a process command line.
  add_route() {
    [ -n "$1" ] || return 0
    document=$(printf '%s' "$document" | ROUTE_PROVIDER="$1" ROUTE_MODEL="$2" ROUTE_KEY="$3" jq '
      .providers = ((.providers // []) + [
        { provider: $ENV.ROUTE_PROVIDER, priority: ((.providers // []) | length) * 10 }
        + (if $ENV.ROUTE_MODEL == "" then {} else { model: $ENV.ROUTE_MODEL } end)
        + (if $ENV.ROUTE_KEY == "" then {} else { credential: { type: "api_key", key: $ENV.ROUTE_KEY } } end)
      ])')
  }
  add_route "${ROGUE_PROVIDER:-}" "${ROGUE_MODEL:-}" "${ROGUE_API_KEY:-}"
  add_route "${ROGUE_FALLBACK_PROVIDER:-}" "${ROGUE_FALLBACK_MODEL:-}" "${ROGUE_FALLBACK_API_KEY:-}"

  if [ -n "${ROGUE_CUSTOM_PROVIDER_URL:-}" ]; then
    custom_id=${ROGUE_CUSTOM_PROVIDER_ID:-local}
    document=$(printf '%s' "$document" | jq \
      --arg id "$custom_id" \
      --arg baseUrl "$ROGUE_CUSTOM_PROVIDER_URL" \
      --arg name "${ROGUE_CUSTOM_PROVIDER_NAME:-}" \
      --arg api "${ROGUE_CUSTOM_PROVIDER_API:-}" \
      --arg contextWindow "${ROGUE_CUSTOM_PROVIDER_CONTEXT:-}" '
      .customProviders = ((.customProviders // []) + [
        { id: $id, baseUrl: $baseUrl }
        + (if $name == "" then {} else { name: $name } end)
        + (if $api == "" then {} else { api: $api } end)
        + (if $contextWindow == "" then {} else { contextWindow: ($contextWindow | tonumber) } end)
      ])')
    if [ -n "${ROGUE_CUSTOM_PROVIDER_KEY:-}" ]; then
      document=$(printf '%s' "$document" | CUSTOM_ID="$custom_id" jq '
        .credentials = ((.credentials // {}) + { ($ENV.CUSTOM_ID): { type: "api_key", key: $ENV.ROGUE_CUSTOM_PROVIDER_KEY } })')
    fi
  fi

  if [ -n "${ROGUE_RELAYS:-}" ]; then
    document=$(printf '%s' "$document" | jq --arg relays "$ROGUE_RELAYS" '
      .relays = ((.relays // []) + ($relays | split("[,[:space:]]+"; "") | map(select(length > 0))))')
  fi

  if [ -n "${ROGUE_HTTP_PROXY:-}" ]; then
    document=$(printf '%s' "$document" | jq '
      .httpProxy = ({ url: $ENV.ROGUE_HTTP_PROXY }
        + (if ($ENV.ROGUE_NO_PROXY // "") == "" then {} else { noProxy: $ENV.ROGUE_NO_PROXY } end))')
  fi

  if [ "$(printf '%s' "$document" | jq 'length')" -eq 0 ]; then
    if [ "$provisioned" = no ] && [ ! -e "$BOOTSTRAP" ]; then
      fail "no configuration was supplied. Set ROGUE_PROVIDER (plus ROGUE_API_KEY unless the model is free), or point ROGUE_INITIAL_AUTH_FILE at a mounted initial_auth.json. See .env.example."
    fi
  else
    printf '%s\n' "$document" >"$BOOTSTRAP"
    chmod 0600 "$BOOTSTRAP"
    note "wrote $BOOTSTRAP; Rogue imports and deletes it on this start"
  fi
fi

# Command arguments stay last so a positional prompt survives; the flags below
# are prepended in whatever order they are set, which the parser does not mind.
if [ "${ROGUE_AUTO_SELECT:-1}" = "1" ]; then set -- --auto-select "$@"; fi
if [ -n "${ROGUE_THINKING:-}" ]; then set -- --thinking "$ROGUE_THINKING" "$@"; fi
if [ -n "${ROGUE_CACHE_RETENTION:-}" ]; then set -- --cache-retention "$ROGUE_CACHE_RETENTION" "$@"; fi
if [ -n "${ROGUE_MAX_CYCLES:-}" ]; then set -- --max-cycles "$ROGUE_MAX_CYCLES" "$@"; fi
# Deliberate word splitting: this variable carries several flags.
# shellcheck disable=SC2086
if [ -n "${ROGUE_EXTRA_ARGS:-}" ]; then set -- $ROGUE_EXTRA_ARGS "$@"; fi

exec node "$BINARY" "$@"
