#!/usr/bin/env bash
set -u

NAMESPACE="/tmp/myopenclaw/linear-agent"
LOG="$NAMESPACE/worker-watchdog.log"
STATE="$NAMESPACE/worker-watchdog.state"
TOKEN_FILE="${LINEAR_RELAY_TOKEN_FILE:-$HOME/.openclaw/openclaw-linear/relay-token}"
STATUS_URL="${LINEAR_WORKER_STATUS_URL:-https://jojo-linear-agent.youmind.ai/linear/status}"
WEBHOOK_URL="${LINEAR_WORKER_WEBHOOK_URL:-https://jojo-linear-agent.youmind.ai/linear/webhook}"
LOCAL_WEBHOOK_URL="${LINEAR_LOCAL_WEBHOOK_URL:-http://127.0.0.1:18789/linear/webhook}"
RELAY_LABEL="${LINEAR_RELAY_LAUNCHD_LABEL:-ai.openclaw.linear-agent-ws-relay}"
QUEUE_WARN_THRESHOLD="${LINEAR_QUEUE_WARN_THRESHOLD:-10}"
ALERT_COOLDOWN_SECONDS="${LINEAR_WATCHDOG_ALERT_COOLDOWN_SECONDS:-900}"
LINEAR_API_URL="${LINEAR_API_URL:-https://api.linear.app/graphql}"

mkdir -p "$NAMESPACE"

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { echo "$(ts) $*" >> "$LOG"; }

http_code() {
  /usr/bin/curl -sS --max-time "$1" -o /dev/null -w '%{http_code}' "$2" 2>/dev/null || echo "000"
}

alert() {
  local key="$1"
  local message="$2"
  local now_epoch last_epoch delta
  now_epoch="$(date +%s)"
  last_epoch=0
  if [[ -f "$STATE.$key" ]]; then
    last_epoch="$(cat "$STATE.$key" 2>/dev/null || echo 0)"
  fi
  delta=$((now_epoch - last_epoch))
  log "ALERT key=$key $message"
  if (( delta < ALERT_COOLDOWN_SECONDS )); then
    return 0
  fi
  echo "$now_epoch" > "$STATE.$key"
  if command -v osascript >/dev/null 2>&1; then
    /usr/bin/osascript -e "display notification \"${message//\"/\\\"}\" with title \"Linear JoJo Agent\"" >/dev/null 2>&1 || true
  fi
}

token=""
if [[ -f "$TOKEN_FILE" ]]; then
  token="$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '\n')"
fi

external_code="$(http_code 8 "$WEBHOOK_URL")"
local_code="$(http_code 5 "$LOCAL_WEBHOOK_URL")"

if [[ "$external_code" != "405" ]]; then
  alert "worker-route" "Worker webhook unhealthy: external=$external_code expected=405"
fi

if [[ "$local_code" != "405" ]]; then
  alert "local-webhook" "Local Linear webhook unhealthy: local=$local_code expected=405"
fi

if [[ -z "$token" ]]; then
  alert "missing-token" "Linear relay token missing: $TOKEN_FILE"
  exit 1
fi

status_json="$(/usr/bin/curl -sS --max-time 8 -H "Authorization: Bearer $token" "$STATUS_URL" 2>/dev/null || true)"
status_values="$(STATUS_JSON="$status_json" node --input-type=commonjs - <<'NODE' 2>/dev/null || true
const data = JSON.parse(process.env.STATUS_JSON || "{}");
const fields = [
  data.connectedClients ?? "",
  data.queued ?? "",
  data.deadLettered ?? "",
  data.inFlight ?? "",
  data.deliverable ?? "",
  data.oldestReceivedAt ?? "",
  data.firstDeliverable?.lastError ?? data.head?.lastError ?? "",
];
process.stdout.write(fields.join("\t"));
NODE
)"

IFS=$'\t' read -r connected queued dead_lettered in_flight deliverable oldest_received last_error <<< "$status_values"

if [[ -z "${connected:-}" ]]; then
  alert "status-fetch" "Worker status fetch failed"
  exit 2
fi

if (( connected < 1 )); then
  log "RESTART relay connectedClients=$connected queued=$queued"
  /bin/launchctl kickstart -k "gui/501/$RELAY_LABEL" >> "$LOG" 2>&1 || true
  sleep 5
  post_json="$(/usr/bin/curl -sS --max-time 8 -H "Authorization: Bearer $token" "$STATUS_URL" 2>/dev/null || true)"
  post_connected="$(STATUS_JSON="$post_json" node --input-type=commonjs -e 'const d=JSON.parse(process.env.STATUS_JSON||"{}"); process.stdout.write(String(d.connectedClients ?? ""));' 2>/dev/null || true)"
  if [[ -z "$post_connected" || "$post_connected" -lt 1 ]]; then
    alert "relay-disconnected" "Linear relay disconnected after restart: connectedClients=${post_connected:-unknown}"
  else
    log "OK relay_recovered connectedClients=$post_connected"
  fi
fi

if (( dead_lettered > 0 )); then
  alert "dead-letter" "Linear Worker has dead-lettered webhooks: deadLettered=$dead_lettered lastError=${last_error:-unknown}"
fi

if (( queued > QUEUE_WARN_THRESHOLD )); then
  alert "queue-backlog" "Linear Worker queue backlog: queued=$queued inFlight=$in_flight deliverable=$deliverable oldest=${oldest_received:-unknown}"
fi

if [[ -n "${LINEAR_API_KEY:-}" && -n "${LINEAR_WEBHOOK_ID:-}" ]]; then
  webhook_json="$(/usr/bin/curl -sS --max-time 10 "$LINEAR_API_URL" \
    -H "Authorization: $LINEAR_API_KEY" \
    -H "Content-Type: application/json" \
    --data "{\"query\":\"query(\\$id:String!){ webhook(id:\\$id){ id enabled url } }\",\"variables\":{\"id\":\"$LINEAR_WEBHOOK_ID\"}}" 2>/dev/null || true)"
  enabled="$(WEBHOOK_JSON="$webhook_json" node --input-type=commonjs -e 'const d=JSON.parse(process.env.WEBHOOK_JSON||"{}"); process.stdout.write(String(d.data?.webhook?.enabled ?? ""));' 2>/dev/null || true)"
  if [[ "$enabled" == "false" ]]; then
    alert "webhook-disabled" "Linear webhook is disabled; attempting to re-enable"
    /usr/bin/curl -sS --max-time 10 "$LINEAR_API_URL" \
      -H "Authorization: $LINEAR_API_KEY" \
      -H "Content-Type: application/json" \
      --data "{\"query\":\"mutation(\\$id:String!){ webhookUpdate(id:\\$id,input:{enabled:true}){ success webhook{ id enabled } } }\",\"variables\":{\"id\":\"$LINEAR_WEBHOOK_ID\"}}" >> "$LOG" 2>&1 || true
  elif [[ -z "$enabled" ]]; then
    log "WARN webhook_status_unavailable"
  fi
fi

log "OK external=$external_code local=$local_code connectedClients=$connected queued=$queued inFlight=$in_flight deadLettered=$dead_lettered"
