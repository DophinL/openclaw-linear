# JoJo Linear Agent Cloudflare Relay

This Worker replaces the old inbound Cloudflare Tunnel dependency for Linear
webhooks.

## Runtime Flow

1. Linear sends `POST /linear/webhook` to Cloudflare Worker.
2. Worker verifies `linear-signature` with `LINEAR_WEBHOOK_SECRET`.
3. Worker stores the raw webhook envelope in the Durable Object queue and
   returns `200 OK` immediately.
4. The local Mac runs `scripts/linear-agent-ws-client.mjs`, which maintains an
   outbound WebSocket to `/linear/connect`.
5. The Durable Object pushes queued webhook envelopes to the local client.
6. The local client posts the original body and Linear headers to
   `http://127.0.0.1:18789/linear/webhook`.
7. The local client sends `ack` only after the local webhook returns a 2xx
   response. Otherwise the Durable Object keeps the item for retry.

## Required Secrets

Set these with Wrangler. Do not commit them.

```bash
cd ~/clawd/skills/openclaw-linear/worker
wrangler secret put LINEAR_WEBHOOK_SECRET
wrangler secret put AGENT_RELAY_TOKEN
```

The same `AGENT_RELAY_TOKEN` value must be stored locally:

```bash
mkdir -p ~/.openclaw/openclaw-linear
printf '%s' '<token>' > ~/.openclaw/openclaw-linear/relay-token
chmod 600 ~/.openclaw/openclaw-linear/relay-token
```

## Deploy

```bash
cd ~/clawd/skills/openclaw-linear/worker
wrangler deploy
```

After deployment, Linear should keep using:

```text
https://jojo-linear-agent.youmind.ai/linear/webhook
```

The previous Cloudflare Tunnel route for `jojo-linear-agent.youmind.ai` must be
removed or it will continue to shadow the Worker route.

## Local Relay LaunchAgent

```bash
cp ~/clawd/skills/openclaw-linear/launchd/ai.openclaw.linear-agent-ws-relay.plist.template \
  ~/Library/LaunchAgents/ai.openclaw.linear-agent-ws-relay.plist
launchctl bootstrap gui/501 ~/Library/LaunchAgents/ai.openclaw.linear-agent-ws-relay.plist
launchctl kickstart -k gui/501/ai.openclaw.linear-agent-ws-relay
```

Logs:

```text
/tmp/myopenclaw/linear-agent/ws-relay.log
/tmp/myopenclaw/linear-agent/ws-relay.err
```

