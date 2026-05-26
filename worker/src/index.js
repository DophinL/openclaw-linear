const MAX_BODY_BYTES = 1024 * 1024;
const IN_FLIGHT_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 5_000;
const MAX_ATTEMPTS = 20;

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

    return textResponse("Not Found", 404);
  },
};

export class LinearAgentRelay {
  constructor(state) {
    this.state = state;
    this.sockets = new Set();
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
      this.sockets.add(server);

      server.addEventListener("message", (event) => {
        this.handleMessage(server, event.data).catch((err) => {
          server.send(JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          }));
        });
      });
      server.addEventListener("close", () => this.sockets.delete(server));
      server.addEventListener("error", () => this.sockets.delete(server));

      server.send(JSON.stringify({ type: "connected" }));
      this.deliverNext().catch(() => {});

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/enqueue") {
      const envelope = await request.json();
      await this.enqueue(envelope);
      return textResponse("OK");
    }

    if (url.pathname === "/status") {
      const queue = await this.getQueue();
      return Response.json({
        queued: queue.length,
        inFlight: queue.filter((item) => item.inFlightAt).length,
        connectedClients: this.sockets.size,
        oldestReceivedAt: queue[0]?.receivedAt ?? null,
      });
    }

    return textResponse("Not Found", 404);
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
    await this.deliverNext();
  }

  async handleMessage(socket, data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (message.type === "ack") {
      await this.ack(message.id);
      await this.deliverNext();
      return;
    }

    if (message.type === "nack") {
      await this.nack(message.id, message.error);
      await this.deliverNext();
      return;
    }

    if (message.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
    }
  }

  async ack(id) {
    const queue = await this.getQueue();
    await this.putQueue(queue.filter((item) => item.id !== id));
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
  }

  async deliverNext() {
    if (this.sockets.size === 0) return;

    const queue = await this.getQueue();
    const now = Date.now();
    const item = queue.find((entry) => {
      if (entry.deadLetteredAt) return false;
      if (entry.nextAttemptAt && entry.nextAttemptAt > now) return false;
      if (!entry.inFlightAt) return true;
      return now - entry.inFlightAt > IN_FLIGHT_TIMEOUT_MS;
    });
    if (!item) return;

    item.inFlightAt = now;
    item.attempts = item.attempts ?? 0;
    await this.putQueue(queue);

    const payload = JSON.stringify({ type: "webhook", item });
    for (const socket of this.sockets) {
      try {
        socket.send(payload);
        return;
      } catch {
        this.sockets.delete(socket);
      }
    }
  }
}

