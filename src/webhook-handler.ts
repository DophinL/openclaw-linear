import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export type LinearWebhookPayload = {
  action: string;
  type: string;
  data: Record<string, unknown>;
  updatedFrom?: Record<string, unknown>;
  createdAt: string;
};

type WebhookHandlerDeps = {
  webhookSecret: string | string[];
  logger: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
  onEvent?: (event: LinearWebhookPayload) => void;
};

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEDUP_MAX_SIZE = 10_000;

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (expected.length !== signature.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createWebhookHandler(deps: WebhookHandlerDeps) {
  /** Map of delivery ID → timestamp for duplicate detection with TTL. */
  const processedDeliveries = new Map<string, number>();

  function pruneDeliveries(): void {
    const now = Date.now();
    for (const [id, ts] of processedDeliveries) {
      if (now - ts > DEDUP_TTL_MS) {
        processedDeliveries.delete(id);
      }
    }
    if (processedDeliveries.size > DEDUP_MAX_SIZE) {
      const excess = processedDeliveries.size - DEDUP_MAX_SIZE;
      const iter = processedDeliveries.keys();
      for (let i = 0; i < excess; i++) {
        const key = iter.next().value;
        if (key !== undefined) processedDeliveries.delete(key);
      }
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end("Method Not Allowed");
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      const msg = formatErrorMessage(err);
      if (msg.includes("too large")) {
        res.writeHead(413);
        res.end("Payload Too Large");
      } else {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
      return;
    }

    const signature = req.headers["linear-signature"];
    const deliveryId = req.headers["linear-delivery"] as string | undefined;
    const signatureString = typeof signature === "string" ? signature : undefined;
    const secrets = Array.isArray(deps.webhookSecret) ? deps.webhookSecret : [deps.webhookSecret];
    const signatureValid = signatureString !== undefined && secrets.some((s) => verifySignature(rawBody, signatureString, s));
    if (!signatureValid) {
      deps.logger.error(
        [
          "[linear] Invalid webhook signature",
          `delivery=${deliveryId ?? "missing"}`,
          `hasSignature=${signatureString !== undefined}`,
          `signatureLength=${signatureString?.length ?? 0}`,
          `bodyBytes=${Buffer.byteLength(rawBody)}`,
          `method=${req.method ?? "unknown"}`,
          `url=${req.url ?? "unknown"}`,
          `userAgent=${String(req.headers["user-agent"] ?? "unknown")}`,
        ].join(" "),
      );
      res.writeHead(400);
      res.end("Invalid signature");
      return;
    }

    let event: LinearWebhookPayload;
    try {
      const payload = JSON.parse(rawBody) as Record<string, unknown>;

      // Prune expired entries periodically
      pruneDeliveries();

      if (deliveryId) {
        if (processedDeliveries.has(deliveryId)) {
          deps.logger.info(`Duplicate delivery skipped: ${deliveryId}`);
          res.writeHead(200);
          res.end("OK");
          return;
        }
        processedDeliveries.set(deliveryId, Date.now());
      }

      event = {
        action: String(payload.action ?? ""),
        type: String(payload.type ?? ""),
        // Some Linear webhook payloads (e.g. OAuth App events) place fields
        // directly on the top-level object instead of nesting under `data`.
        // Fall back to the full payload so downstream handlers still see data.
        data: (payload.data as Record<string, unknown>) ?? payload,
        updatedFrom: (payload.updatedFrom as Record<string, unknown>) ?? undefined,
        createdAt: String(payload.createdAt ?? ""),
      };

      deps.logger.info(`Linear webhook: ${event.action} ${event.type} (${String(event.data.id ?? "unknown")})`);
    } catch (err) {
      deps.logger.error(`Webhook parse error: ${formatErrorMessage(err)}`);
      res.writeHead(500);
      res.end("Internal Server Error");
      return;
    }

    // Always return 200 after successful parse — onEvent errors must not
    // cause Linear to retry (which could create a retry storm).
    res.writeHead(200);
    res.end("OK");

    try {
      deps.onEvent?.(event);
    } catch (err) {
      deps.logger.error(`Event handler error: ${formatErrorMessage(err)}`);
    }
  };
}
