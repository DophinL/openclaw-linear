#!/usr/bin/env node
import { readFileSync } from "node:fs";

const relayUrl = process.env.LINEAR_RELAY_URL ?? "wss://jojo-linear-agent.youmind.ai/linear/connect";
const localWebhookUrl = process.env.LINEAR_LOCAL_WEBHOOK_URL ?? "http://127.0.0.1:18789/linear/webhook";
const relayToken = process.env.LINEAR_RELAY_TOKEN ?? readTokenFile();

if (!relayToken) {
  console.error("[linear-relay] LINEAR_RELAY_TOKEN is required");
  process.exit(1);
}

let reconnectAttempt = 0;
let pingTimer;

function readTokenFile() {
  const path = process.env.LINEAR_RELAY_TOKEN_FILE;
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reconnectDelayMs() {
  const capped = Math.min(reconnectAttempt, 8);
  const base = 1000 * 2 ** capped;
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(base + jitter, 60_000);
}

async function deliver(item) {
  const headers = {
    "content-type": item.headers?.["content-type"] ?? "application/json",
    "linear-signature": item.headers?.["linear-signature"] ?? "",
    "linear-delivery": item.headers?.["linear-delivery"] ?? item.id,
    "user-agent": "openclaw-linear-relay/1.0",
    "x-openclaw-linear-relay": "cloudflare-ws",
  };

  const response = await fetch(localWebhookUrl, {
    method: "POST",
    headers,
    body: item.rawBody,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`local webhook returned ${response.status}: ${body.slice(0, 200)}`);
  }
}

async function connectForever() {
  while (true) {
    const url = new URL(relayUrl);
    url.searchParams.set("token", relayToken);
    const ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      console.log(`[linear-relay] connected to ${relayUrl}`);
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 25_000);
    });

    ws.addEventListener("message", (event) => {
      void handleMessage(ws, event.data);
    });

    const closed = new Promise((resolve) => {
      ws.addEventListener("close", resolve, { once: true });
      ws.addEventListener("error", resolve, { once: true });
    });

    await closed;
    clearInterval(pingTimer);
    reconnectAttempt += 1;
    const delay = reconnectDelayMs();
    console.error(`[linear-relay] disconnected; reconnecting in ${delay}ms`);
    await sleep(delay);
  }
}

async function handleMessage(ws, data) {
  let message;
  try {
    message = JSON.parse(String(data));
  } catch {
    console.error("[linear-relay] invalid message from worker");
    return;
  }

  if (message.type !== "webhook") return;
  const item = message.item;
  if (!item?.id) return;

  try {
    await deliver(item);
    ws.send(JSON.stringify({ type: "ack", id: item.id }));
    console.log(`[linear-relay] delivered ${item.id}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ws.send(JSON.stringify({ type: "nack", id: item.id, error }));
    console.error(`[linear-relay] delivery failed ${item.id}: ${error}`);
  }
}

connectForever().catch((err) => {
  console.error(`[linear-relay] fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
