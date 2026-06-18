const MAX_BODY_BYTES = 1024 * 1024;
const IN_FLIGHT_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 5_000;
const MAX_ATTEMPTS = 20;
const CLIENT_STALE_MS = 90_000;
const MAX_DRAIN_PER_TICK = 16;

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...headers,
    },
  });
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readBodyWithLimit(request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new Response("Payload Too Large", { status: 413 });
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new Response("Payload Too Large", { status: 413 });
  }
  return body;
}

async function verifyLinearSignature(request, rawBody, env) {
  const secret = env.LINEAR_WEBHOOK_SECRET;
  if (!secret) {
    return { ok: false, status: 500, body: "LINEAR_WEBHOOK_SECRET not configured" };
  }

  const actual = request.headers.get("linear-signature");
  if (!actual) {
    return { ok: false, status: 400, body: "Missing linear-signature" };
  }

  const expected = await hmacSha256Hex(secret, rawBody);
  if (!timingSafeEqualHex(expected, actual)) {
    return { ok: false, status: 400, body: "Invalid signature" };
  }

  return { ok: true };
}

function requireRelayAuth(request, env) {
  const token = env.AGENT_RELAY_TOKEN;
  if (!token) {
    return textResponse("AGENT_RELAY_TOKEN not configured", 500);
  }

  const auth = request.headers.get("authorization") ?? "";
  const urlToken = new URL(request.url).searchParams.get("token");
  const actual = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice("bearer ".length)
    : urlToken;

  if (actual !== token) {
    return textResponse("Unauthorized", 401);
  }

  return undefined;
}

function relayStub(env) {
  const id = env.LINEAR_RELAY.idFromName("linear-agent");
  return env.LINEAR_RELAY.get(id);
}

function isRetryable(item, now) {
  if (item.deadLetteredAt) return false;
  if (item.nextAttemptAt && item.nextAttemptAt > now) return false;
  if (!item.inFlightAt) return true;
  return now - item.inFlightAt > IN_FLIGHT_TIMEOUT_MS;
}

function summarizeQueueItem(item) {
  if (!item) return null;
  return {
    id: item.id,
    receivedAt: item.receivedAt ?? null,
    attempts: item.attempts ?? 0,
    deliveryCount: item.deliveryCount ?? 0,
    inFlightAt: item.inFlightAt ?? null,
    nextAttemptAt: item.nextAttemptAt ?? null,
    deadLetteredAt: item.deadLetteredAt ?? null,
    lastError: item.lastError ?? null,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/linear/webhook") {
      if (request.method !== "POST") {
        return textResponse("Method Not Allowed", 405, { allow: "POST" });
      }

      let rawBody;
      try {
        rawBody = await readBodyWithLimit(request);
      } catch (err) {
        if (err instanceof Response) return err;
        return textResponse("Internal Server Error", 500);
      }

      const verification = await verifyLinearSignature(request, rawBody, env);
      if (!verification.ok) {
        return textResponse(verification.body, verification.status);
      }

      const deliveryId =
        request.headers.get("linear-delivery") ??
        `sha256:${await sha256Hex(rawBody)}`;

      const envelope = {
        id: deliveryId,
        rawBody,
        headers: {
          "content-type": request.headers.get("content-type") ?? "application/json",
          "linear-signature": request.headers.get("linear-signature") ?? "",
          "linear-delivery": deliveryId,
          "user-agent": request.headers.get("user-agent") ?? "linear-webhook",
        },
        receivedAt: new Date().toISOString(),
        attempts: 0,
      };

      const response = await relayStub(env).fetch("https://linear-relay/enqueue", {
        method: "POST",
        body: JSON.stringify(envelope),
        headers: { "content-type": "application/json" },
      });

      if (!response.ok) {
        return textResponse("Relay enqueue failed", 500);
      }

      return textResponse("OK");
    }

    if (url.pathname === "/linear/connect") {
      const authError = requireRelayAuth(request, env);
      if (authError) return authError;
      return relayStub(env).fetch(request);
    }

    if (url.pathname === "/linear/status") {
      const authError = requireRelayAuth(request, env);
      if (authError) return authError;
      return relayStub(env).fetch("https://linear-relay/status");
    }

    if (url.pathname.startsWith("/linear/admin/")) {
      const authError = requireRelayAuth(request, env);
      if (authError) return authError;
      const adminPath = url.pathname.slice("/linear".length);
      return relayStub(env).fetch(`https://linear-relay${adminPath}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    }

    return textResponse("Not Found", 404);
  },
};

export class LinearAgentRelay {
  constructor(state) {
    this.state = state;
    this.sockets = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/linear/connect") {
      if (request.headers.get("upgrade") !== "websocket") {
        return textResponse("Expected WebSocket", 426);
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.set(server, {
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
      });

      server.addEventListener("message", (event) => {
        this.handleMessage(server, event.data).catch((err) => {
          server.send(JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          }));
        });
      });
      server.addEventListener("close", () => this.dropSocket(server));
      server.addEventListener("error", () => this.dropSocket(server));

      server.send(JSON.stringify({ type: "connected" }));
      this.drainQueue().catch(() => {});

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/enqueue") {
      const envelope = await request.json();
      await this.enqueue(envelope);
      return textResponse("OK");
    }

    if (url.pathname === "/status") {
      const queue = await this.getQueue();
      const now = Date.now();
      const deliverable = queue.filter((item) => isRetryable(item, now)).length;
      const deadLettered = queue.filter((item) => item.deadLetteredAt).length;
      const inFlight = queue.filter((item) => item.inFlightAt && !item.deadLetteredAt).length;
      const nextAttemptAt = queue
        .filter((item) => !item.deadLetteredAt && item.nextAttemptAt && item.nextAttemptAt > now)
        .map((item) => item.nextAttemptAt)
        .sort((a, b) => a - b)[0] ?? null;
      return Response.json({
        queued: queue.length,
        inFlight,
        deliverable,
        deadLettered,
        connectedClients: this.getOpenSockets().length,
        oldestReceivedAt: queue[0]?.receivedAt ?? null,
        oldestDeliverableAt: queue.find((item) => isRetryable(item, now))?.receivedAt ?? null,
        nextAttemptAt,
        head: summarizeQueueItem(queue[0]),
        firstDeliverable: summarizeQueueItem(queue.find((item) => isRetryable(item, now))),
      });
    }

    if (url.pathname === "/admin/retry-dead-letter" && request.method === "POST") {
      const queue = await this.getQueue();
      const now = Date.now();
      let updated = 0;
      for (const item of queue) {
        if (!item.deadLetteredAt) continue;
        delete item.deadLetteredAt;
        delete item.inFlightAt;
        item.nextAttemptAt = now;
        item.lastError = undefined;
        updated += 1;
      }
      await this.putQueue(queue);
      await this.drainQueue();
      return Response.json({ ok: true, retried: updated });
    }

    if (url.pathname === "/admin/requeue-inflight" && request.method === "POST") {
      const queue = await this.getQueue();
      const now = Date.now();
      let updated = 0;
      for (const item of queue) {
        if (!item.inFlightAt || item.deadLetteredAt) continue;
        delete item.inFlightAt;
        item.nextAttemptAt = now;
        updated += 1;
      }
      await this.putQueue(queue);
      await this.drainQueue();
      return Response.json({ ok: true, requeued: updated });
    }

    if (url.pathname === "/admin/purge-dead-letter" && request.method === "POST") {
      const queue = await this.getQueue();
      const nextQueue = queue.filter((item) => !item.deadLetteredAt);
      await this.putQueue(nextQueue);
      return Response.json({ ok: true, purged: queue.length - nextQueue.length });
    }

    return textResponse("Not Found", 404);
  }

  async alarm() {
    await this.expireTimedOutInFlight();
    await this.drainQueue();
    await this.scheduleNextQueueAlarm();
  }

  async getQueue() {
    return (await this.state.storage.get("queue")) ?? [];
  }

  async putQueue(queue) {
    await this.state.storage.put("queue", queue);
  }

  async enqueue(envelope) {
    const queue = await this.getQueue();
    if (!queue.some((item) => item.id === envelope.id)) {
      queue.push(envelope);
      await this.putQueue(queue);
    }
    await this.drainQueue();
  }

  async handleMessage(socket, data) {
    const meta = this.sockets.get(socket);
    if (meta) meta.lastSeenAt = Date.now();

    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (message.type === "ack") {
      await this.ack(message.id);
      await this.drainQueue();
      return;
    }

    if (message.type === "nack") {
      await this.nack(message.id, message.error);
      await this.drainQueue();
      return;
    }

    if (message.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
    }
  }

  async ack(id) {
    const queue = await this.getQueue();
    await this.putQueue(queue.filter((item) => item.id !== id));
    await this.scheduleNextQueueAlarm();
  }

  async nack(id, error) {
    const queue = await this.getQueue();
    const now = Date.now();

    for (const item of queue) {
      if (item.id !== id) continue;
      item.attempts = (item.attempts ?? 0) + 1;
      item.inFlightAt = undefined;
      item.nextAttemptAt = now + RETRY_DELAY_MS;
      item.lastError = String(error ?? "unknown");
      if (item.attempts >= MAX_ATTEMPTS) {
        item.deadLetteredAt = new Date().toISOString();
        item.nextAttemptAt = Number.MAX_SAFE_INTEGER;
      }
      break;
    }

    await this.putQueue(queue);
    await this.scheduleAlarm(RETRY_DELAY_MS);
  }

  dropSocket(socket) {
    this.sockets.delete(socket);
    try {
      socket.close();
    } catch {
      // Closing an already-closed WebSocket is harmless.
    }
  }

  getOpenSockets() {
    const now = Date.now();
    const openSockets = [];
    for (const [socket, meta] of this.sockets.entries()) {
      const readyState = socket.readyState;
      const isOpen =
        readyState === undefined ||
        readyState === 1 ||
        readyState === WebSocket.OPEN;
      if (!isOpen || now - meta.lastSeenAt > CLIENT_STALE_MS) {
        this.dropSocket(socket);
        continue;
      }
      openSockets.push(socket);
    }
    return openSockets;
  }

  async expireTimedOutInFlight() {
    const queue = await this.getQueue();
    const now = Date.now();
    let changed = false;
    for (const item of queue) {
      if (!item.inFlightAt || item.deadLetteredAt) continue;
      if (now - item.inFlightAt <= IN_FLIGHT_TIMEOUT_MS) continue;
      item.attempts = (item.attempts ?? 0) + 1;
      item.lastError = "Timed out waiting for relay ack";
      delete item.inFlightAt;
      item.nextAttemptAt = now + RETRY_DELAY_MS;
      if (item.attempts >= MAX_ATTEMPTS) {
        item.deadLetteredAt = new Date().toISOString();
        item.nextAttemptAt = Number.MAX_SAFE_INTEGER;
      }
      changed = true;
    }
    if (changed) {
      await this.putQueue(queue);
    }
  }

  async drainQueue() {
    await this.expireTimedOutInFlight();

    const sockets = this.getOpenSockets();
    if (sockets.length === 0) {
      await this.scheduleNextQueueAlarm();
      return;
    }

    const queue = await this.getQueue();
    const now = Date.now();
    let socketIndex = 0;
    let sent = 0;
    let changed = false;

    for (const item of queue) {
      if (sent >= Math.min(MAX_DRAIN_PER_TICK, sockets.length)) break;
      if (!isRetryable(item, now)) continue;

      const socket = sockets[socketIndex % sockets.length];
      socketIndex += 1;
      item.inFlightAt = now;
      item.nextAttemptAt = undefined;
      item.deliveryCount = (item.deliveryCount ?? 0) + 1;
      changed = true;

      const payload = JSON.stringify({ type: "webhook", item });
      try {
        socket.send(payload);
        sent += 1;
      } catch {
        this.dropSocket(socket);
        delete item.inFlightAt;
        item.nextAttemptAt = now + RETRY_DELAY_MS;
      }
    }

    if (changed) {
      await this.putQueue(queue);
    }

    if (sent > 0) {
      await this.scheduleAlarm(IN_FLIGHT_TIMEOUT_MS + 1_000);
      return;
    }

    await this.scheduleNextQueueAlarm(queue);
  }

  async scheduleAlarm(delayMs) {
    const alarmAt = Date.now() + delayMs;
    const current = await this.state.storage.getAlarm();
    if (!current || current > alarmAt) {
      await this.state.storage.setAlarm(alarmAt);
    }
  }

  async scheduleNextQueueAlarm(existingQueue) {
    const queue = existingQueue ?? await this.getQueue();
    const now = Date.now();
    const candidates = [];

    for (const item of queue) {
      if (item.deadLetteredAt) continue;
      if (item.inFlightAt) {
        candidates.push(item.inFlightAt + IN_FLIGHT_TIMEOUT_MS + 1_000);
      } else if (item.nextAttemptAt && item.nextAttemptAt > now) {
        candidates.push(item.nextAttemptAt);
      }
    }

    const next = candidates.sort((a, b) => a - b)[0];
    if (next) {
      const current = await this.state.storage.getAlarm();
      if (!current || current > next) {
        await this.state.storage.setAlarm(next);
      }
    }
  }
}
