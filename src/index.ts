import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { createWebhookHandler } from "./webhook-handler.js";
import { createEventRouter, type RouterAction } from "./event-router.js";
import { InboxQueue, type EnqueueEntry } from "./work-queue.js";
import { createQueueTool } from "./tools/queue-tool.js";
import { setApiKey } from "./linear-api.js";
import { createIssueTool } from "./tools/linear-issue-tool.js";
import { createCommentTool } from "./tools/linear-comment-tool.js";
import { createTeamTool } from "./tools/linear-team-tool.js";
import { createProjectTool } from "./tools/linear-project-tool.js";
import { createRelationTool } from "./tools/linear-relation-tool.js";

const CHANNEL_ID = "linear";
const DEFAULT_DEBOUNCE_MS = 30_000;
const LINEAR_API_URL = "https://api.linear.app/graphql";
const LINEAR_OAUTH_URL = "https://api.linear.app/oauth/token";
const CRED_PATH = `${process.env.HOME ?? ""}/.linear/credentials/jojo.json`;
const AGENT_MEDIA_DIR = `${process.env.HOME ?? ""}/.openclaw/openclaw-linear/media`;
// Refresh when token expires in less than REFRESH_BEFORE_MS
const REFRESH_BEFORE_MS = 3_600_000; // 1 hour;
const PUBLIC_FILE_URLS_EXPIRE_SECONDS = 10 * 60;
const MAX_AGENT_SESSION_MEDIA = 8;
const MAX_LINEAR_FILE_BYTES = 20 * 1024 * 1024;
const AGENT_SESSION_FINAL_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const AGENT_SESSION_FINAL_RECOVERY_ATTEMPTS = 300;
const AGENT_SESSION_FINAL_RECOVERY_INTERVAL_MS = 2_000;

const EVENT_LABELS: Record<string, string> = {
  "issue.assigned": "Assigned",
  "issue.unassigned": "Unassigned",
  "issue.reassigned": "Reassigned",
  "issue.removed": "Removed",
  "issue.state_removed": "State Removed",
  "issue.state_readded": "State Re-added",
  "issue.priority_changed": "Priority Changed",
  "comment.mention": "Mentioned",
  "agent_session.created": "Agent Session Created",
  "agent_session.prompted": "Agent Session Prompted",
};

type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

type AgentSessionContext = {
  conversationText: string;
  mediaPaths: string[];
  mediaTypes: string[];
};

type AgentActivityNode = {
  updatedAt?: string;
  createdAt?: string;
  content?: Record<string, unknown>;
};

type AgentSessionQueryResult = {
  agentSession?: {
    issue?: {
      id?: string;
      identifier?: string;
      title?: string;
      team?: { id?: string } | null;
      state?: { type?: string } | null;
      delegate?: { id?: string } | null;
      attachments?: {
        nodes?: { url?: string; title?: string; metadata?: unknown }[];
      } | null;
    } | null;
    activities?: {
      edges?: { node?: AgentActivityNode | null }[];
      nodes?: AgentActivityNode[];
    } | null;
  } | null;
};

type ActiveAgentSession = {
  agentId: string;
  agentSessionId: string;
  sessionKey: string;
  cancelled: boolean;
  abortController: AbortController;
};

interface CredentialData {
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
  clientId: string;
  clientSecret: string;
  scope: string;
}

const activeAgentSessions = new Map<string, ActiveAgentSession>();

function buildAgentSessionKey(action: RouterAction): string {
  return `agent:${action.agentId}:linear-agent-session:${action.agentSessionId}`;
}

function getOrCreateActiveAgentSession(action: RouterAction): ActiveAgentSession {
  const agentSessionId = action.agentSessionId!;
  const existing = activeAgentSessions.get(agentSessionId);
  if (existing) {
    existing.agentId = action.agentId;
    existing.sessionKey = buildAgentSessionKey(action);
    return existing;
  }

  const active: ActiveAgentSession = {
    agentId: action.agentId,
    agentSessionId,
    sessionKey: buildAgentSessionKey(action),
    cancelled: false,
    abortController: new AbortController(),
  };
  activeAgentSessions.set(agentSessionId, active);
  return active;
}

function markAgentSessionCancelled(action: RouterAction): ActiveAgentSession | undefined {
  if (!action.agentSessionId) return undefined;
  const active = getOrCreateActiveAgentSession(action);
  active.cancelled = true;
  active.abortController.abort();
  return active;
}

function isAgentSessionCancelled(action: RouterAction): boolean {
  return action.agentSessionId
    ? activeAgentSessions.get(action.agentSessionId)?.cancelled === true
    : false;
}

function clearActiveAgentSession(action: RouterAction, active: ActiveAgentSession): void {
  if (
    action.agentSessionId
    && activeAgentSessions.get(action.agentSessionId) === active
    && !active.cancelled
  ) {
    activeAgentSessions.delete(action.agentSessionId);
  }
}

/**
 * Returns true if the token file exists and the token is still valid for at least `minValidMs`.
 */
function isTokenValid(minValidMs = REFRESH_BEFORE_MS): boolean {
  if (!existsSync(CRED_PATH)) return false;
  try {
    const raw = JSON.parse(readFileSync(CRED_PATH, "utf8")) as { tokenExpiresAt?: number };
    if (!raw.tokenExpiresAt) return false;
    return Date.now() + minValidMs < raw.tokenExpiresAt;
  } catch {
    return false;
  }
}

/**
 * Writes refreshed credentials back to the jojo.json file.
 * Returns the new access token.
 */
async function refreshOAuthToken(cred: CredentialData, logger: { info: (m: string) => void; error: (m: string) => void }): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: cred.clientId,
    client_secret: cred.clientSecret,
    refresh_token: cred.refreshToken,
    scope: cred.scope,
  });

  const res = await fetch(LINEAR_OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth refresh HTTP ${res.status}: ${text}`);
  }

  const json = await res.json() as { access_token: string; refresh_token: string; expires_in: number };

  const updated: CredentialData = {
    ...cred,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    tokenExpiresAt: Date.now() + json.expires_in * 1000,
  };

  writeFileSync(CRED_PATH, JSON.stringify(updated, null, 2));
  logger.info("[linear] OAuth token refreshed successfully");
  return json.access_token;
}

/**
 * Returns a valid access token, refreshing if necessary.
 * Lazy: only refreshes when the token is missing or will expire within 1 hour.
 */
async function getValidAccessToken(logger: { info: (m: string) => void; error: (m: string) => void }): Promise<string | undefined> {
  if (!existsSync(CRED_PATH)) return undefined;

  try {
    const cred: CredentialData = JSON.parse(readFileSync(CRED_PATH, "utf8"));
    if (!cred.accessToken || !cred.refreshToken) return undefined;

    // If token is still valid for at least 1 hour, return it directly
    if (isTokenValid(REFRESH_BEFORE_MS)) {
      return cred.accessToken;
    }

    // Token missing, expired, or about to expire — refresh
    return await refreshOAuthToken(cred, logger);
  } catch (err) {
    logger.error(`[linear] getValidAccessToken error: ${formatErrorMessage(err)}`);
    return undefined;
  }
}

async function linearGraphql<T>(
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      Authorization: accessToken,
      "Content-Type": "application/json",
      // Linear private upload URLs in GraphQL responses can be signed for
      // temporary server-side reads. We still send Authorization when
      // downloading as a fallback for unsigned uploads.linear.app URLs.
      "public-file-urls-expire-in": String(PUBLIC_FILE_URLS_EXPIRE_SECONDS),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Linear GraphQL HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
  }
  return json.data as T;
}

// --- Proactive refresh scheduler ---
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function scheduleProactiveRefresh(logger: { info: (m: string) => void; error: (m: string) => void }): void {
  if (refreshTimer) clearInterval(refreshTimer);
  // Check and refresh every 20 hours (token is valid 24h)
  refreshTimer = setInterval(async () => {
    if (!isTokenValid(REFRESH_BEFORE_MS)) {
      try {
        const cred: CredentialData = JSON.parse(readFileSync(CRED_PATH, "utf8"));
        await refreshOAuthToken(cred, logger);
      } catch (err) {
        logger.error(`[linear] Proactive token refresh failed: ${formatErrorMessage(err)}`);
      }
    }
  }, 20 * 60 * 60 * 1000);
}

export function formatConsolidatedMessage(actions: RouterAction[]): string {
  if (actions.length === 1) {
    return actions[0].detail;
  }

  const lines = actions.map((a, i) => {
    const label = EVENT_LABELS[a.event] ?? a.event;
    const summary = formatActionSummary(a);
    return `${i + 1}. [${label}] ${summary}`;
  });

  return `You have ${actions.length} new Linear notifications:\n\n${lines.join("\n")}\n\nReview and prioritize before starting work.`;
}

function formatActionSummary(action: RouterAction): string {
  if (action.event === "comment.mention") {
    const bodyStart = action.detail.indexOf("\n\n> ");
    if (bodyStart !== -1) {
      const quote = action.detail.slice(bodyStart + 4); // skip "\n\n> "
      return `${action.issueLabel}: "${quote}"`;
    }
  }

  return action.issueLabel || action.detail;
}

async function dispatchConsolidatedActions(
  actions: RouterAction[],
  api: OpenClawPluginApi,
  queue: InboxQueue,
): Promise<void> {
  if (actions.length === 0) return;

  const core = api.runtime;
  const cfg = api.config;

  const first = actions[0];

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: "default",
    peer: {
      kind: "direct" as const,
      id: first.linearUserId,
    },
  });

  // Write to queue deterministically — no LLM involved
  const entries: EnqueueEntry[] = actions.map((a) => ({
    id: a.commentId || a.identifier,
    issueId: a.identifier,
    event: a.event,
    summary: a.issueLabel,
    issuePriority: a.issuePriority,
  }));
  const added = await queue.enqueue(entries);

  if (added === 0) {
    api.logger.info("[linear] All notifications deduped — skipping agent dispatch");
    return;
  }

  // Agent gets a minimal notification pointing to the linear_queue tool
  const body = `${added} new Linear notification(s) queued. Use the linear_queue tool to process them.`;

  const ctx = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    From: `${CHANNEL_ID}:${first.linearUserId}`,
    To: `${CHANNEL_ID}:${first.agentId}`,
    SessionKey: `agent:${first.agentId}:main`,
    AccountId: route.accountId ?? "default",
    ChatType: "direct",
    ConversationLabel: `Linear: batch (${actions.length} events)`,
    SenderId: first.linearUserId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${first.linearUserId}`,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async () => {
        // No-op: agent uses Linear tools to respond to specific issues after triage
      },
      onError: (err: unknown) => {
        api.logger.error(
          `[linear] Reply error: ${formatErrorMessage(err)}`,
        );
      },
    },
  });
}

function readJojoAgentAccessToken(): string | undefined {
  const home = process.env.HOME;
  if (!home) return undefined;
  const credPath = `${home}/.linear/credentials/jojo.json`;
  if (!existsSync(credPath)) return undefined;
  try {
    const data = JSON.parse(readFileSync(credPath, "utf8")) as {
      accessToken?: string;
    };
    return data.accessToken;
  } catch {
    return undefined;
  }
}

async function acknowledgeMention(action: RouterAction, api: OpenClawPluginApi): Promise<void> {
  if (action.event !== "comment.mention" || !action.commentId) return;

  const accessToken = await getValidAccessToken(api.logger);
  if (!accessToken) {
    api.logger.info("[linear] ACK skipped: jojo Linear credentials not found");
    return;
  }

  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      Authorization: accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `mutation($input: ReactionCreateInput!) {
        reactionCreate(input: $input) { success reaction { id emoji } }
      }`,
      variables: {
        input: {
          emoji: "👀",
          commentId: action.commentId,
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Linear ACK HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`Linear ACK error: ${json.errors[0].message}`);
  }
}

async function createAgentActivity(
  agentSessionId: string,
  content: AgentActivityContent,
  api: OpenClawPluginApi,
): Promise<void> {
  const accessToken = await getValidAccessToken(api.logger);
  if (!accessToken) {
    api.logger.info("[linear] AgentActivity skipped: jojo Linear credentials not found");
    return;
  }

  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      Authorization: accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
          agentActivity { id }
        }
      }`,
      variables: {
        input: {
          agentSessionId,
          content,
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Linear AgentActivity HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`Linear AgentActivity error: ${json.errors[0].message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectRecentCodexSessionFiles(root: string, sinceMs: number): string[] {
  const files: { path: string; mtimeMs: number }[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

      try {
        const stat = statSync(fullPath);
        if (stat.mtimeMs >= sinceMs) {
          files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
        }
      } catch {}
    }
  }

  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).map((file) => file.path);
}

function extractFinalTextFromCodexLog(content: string): string | undefined {
  let finalText: string | undefined;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const record = event as {
      type?: string;
      payload?: {
        type?: string;
        phase?: string;
        message?: string;
        content?: { type?: string; text?: string }[];
      };
    };

    if (
      record.type === "event_msg" &&
      record.payload?.type === "agent_message" &&
      record.payload.phase === "final_answer" &&
      typeof record.payload.message === "string"
    ) {
      const text = record.payload.message.trim();
      if (text && text !== "NO_REPLY") finalText = text;
      continue;
    }

    if (
      record.type === "response_item" &&
      record.payload?.type === "message" &&
      record.payload.phase === "final_answer" &&
      Array.isArray(record.payload.content)
    ) {
      const text = record.payload.content
        .filter((item) => item.type === "output_text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("")
        .trim();
      if (text && text !== "NO_REPLY") finalText = text;
    }
  }

  return finalText;
}

async function recoverAgentSessionFinalFromLogs(
  action: RouterAction,
  startedAtMs: number,
  api: OpenClawPluginApi,
): Promise<string | undefined> {
  const root = join(
    process.env.HOME ?? "",
    ".openclaw",
    "agents",
    action.agentId,
    "agent",
    "codex-home",
    "sessions",
  );
  const sinceMs = Math.max(0, startedAtMs - AGENT_SESSION_FINAL_RECOVERY_WINDOW_MS);

  for (let attempt = 0; attempt < AGENT_SESSION_FINAL_RECOVERY_ATTEMPTS; attempt += 1) {
    for (const file of collectRecentCodexSessionFiles(root, sinceMs)) {
      let content = "";
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      if (!content.includes(action.agentSessionId ?? "")) continue;

      const text = extractFinalTextFromCodexLog(content);
      if (text) {
        api.logger.info(`[linear] recovered Agent Session final from Codex log: ${file}`);
        return text;
      }
    }
    await sleep(AGENT_SESSION_FINAL_RECOVERY_INTERVAL_MS);
  }

  return undefined;
}

function contentBody(content: Record<string, unknown> | undefined): string | undefined {
  const body = content?.body;
  return typeof body === "string" && body.trim() ? body : undefined;
}

function flattenActivityNodes(
  activities: NonNullable<AgentSessionQueryResult["agentSession"]>["activities"] | undefined,
): AgentActivityNode[] {
  if (!activities || typeof activities !== "object") return [];
  const a = activities;
  if (Array.isArray(a?.nodes)) return a.nodes.filter(Boolean);
  if (Array.isArray(a?.edges)) {
    return a.edges.map((edge) => edge.node).filter((node): node is AgentActivityNode => Boolean(node));
  }
  return [];
}

function formatAgentActivities(nodes: AgentActivityNode[]): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const content = node.content;
    if (!content || typeof content !== "object") continue;
    const typename = typeof content.__typename === "string" ? content.__typename : "AgentActivity";
    const body = contentBody(content);
    if (!body) continue;
    const label = typename.replace(/^AgentActivity/, "").replace(/Content$/, "") || "Activity";
    const at = node.updatedAt ?? node.createdAt;
    lines.push(`- ${at ? `[${at}] ` : ""}${label}: ${body}`);
  }
  return lines.join("\n");
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function extractLinearUploadUrls(...values: unknown[]): string[] {
  const urls = new Set<string>();
  const urlRegex = /https:\/\/uploads\.linear\.app\/[^\s)\]}>"']+/g;
  for (const value of values) {
    for (const text of collectStrings(value)) {
      for (const match of text.matchAll(urlRegex)) {
        urls.add(match[0].replace(/[.,;:]+$/, ""));
      }
    }
  }
  return [...urls];
}

function extensionForContentType(contentType: string | null, url: string): string {
  const fromUrl = extname(new URL(url).pathname);
  if (fromUrl && fromUrl.length <= 10) return fromUrl;
  const type = (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  if (type === "application/pdf") return ".pdf";
  if (type === "text/plain") return ".txt";
  return ".bin";
}

async function downloadLinearFile(
  url: string,
  accessToken: string,
  logger: { info: (m: string) => void; error: (m: string) => void },
): Promise<{ path: string; mediaType: string } | undefined> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: accessToken },
    });
    if (!res.ok) {
      logger.error(`[linear] Failed to download attachment ${url}: HTTP ${res.status}`);
      return undefined;
    }

    const contentLength = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_LINEAR_FILE_BYTES) {
      logger.error(`[linear] Skipping oversized attachment ${url}: ${contentLength} bytes`);
      return undefined;
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_LINEAR_FILE_BYTES) {
      logger.error(`[linear] Skipping oversized attachment ${url}: ${arrayBuffer.byteLength} bytes`);
      return undefined;
    }

    mkdirSync(AGENT_MEDIA_DIR, { recursive: true });
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
    const ext = extensionForContentType(contentType, url);
    const path = join(AGENT_MEDIA_DIR, `${hash}${ext}`);
    writeFileSync(path, Buffer.from(arrayBuffer));
    return { path, mediaType: contentType };
  } catch (err) {
    logger.error(`[linear] Attachment download error: ${formatErrorMessage(err)}`);
    return undefined;
  }
}

async function fetchAgentSessionContext(
  action: RouterAction,
  accessToken: string,
  api: OpenClawPluginApi,
): Promise<AgentSessionContext> {
  const data = await linearGraphql<AgentSessionQueryResult>(
    accessToken,
    `query AgentSessionContext($id: String!) {
      agentSession(id: $id) {
        issue {
          id
          identifier
          title
          team { id }
          state { type }
          delegate { id }
          attachments { nodes { url title metadata } }
        }
        activities {
          edges {
            node {
              updatedAt
              content {
                __typename
                ... on AgentActivityThoughtContent { body }
                ... on AgentActivityActionContent { action parameter result }
                ... on AgentActivityElicitationContent { body }
                ... on AgentActivityResponseContent { body }
                ... on AgentActivityErrorContent { body }
                ... on AgentActivityPromptContent { body }
              }
            }
          }
        }
      }
    }`,
    { id: action.agentSessionId },
  );

  const activityText = formatAgentActivities(flattenActivityNodes(data.agentSession?.activities));
  const issueAttachments = data.agentSession?.issue?.attachments?.nodes ?? [];
  const uploadUrls = extractLinearUploadUrls(
    action.promptContext,
    action.detail,
    data.agentSession?.activities,
    issueAttachments,
  ).slice(0, MAX_AGENT_SESSION_MEDIA);

  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  for (const url of uploadUrls) {
    const downloaded = await downloadLinearFile(url, accessToken, api.logger);
    if (!downloaded) continue;
    mediaPaths.push(downloaded.path);
    mediaTypes.push(downloaded.mediaType);
  }

  const attachmentList = issueAttachments
    .filter((attachment) => attachment.url)
    .map((attachment) => `- ${attachment.title ?? "Attachment"}: ${attachment.url}`)
    .join("\n");

  const conversationText = [
    action.promptContext || action.detail,
    activityText ? `Agent activity history (frozen user/agent messages):\n${activityText}` : "",
    attachmentList ? `Issue attachments:\n${attachmentList}` : "",
  ].filter(Boolean).join("\n\n");

  return { conversationText, mediaPaths, mediaTypes };
}

async function alignIssueWithAgentBestPractices(
  action: RouterAction,
  accessToken: string,
  api: OpenClawPluginApi,
): Promise<void> {
  if (!action.agentSessionId) return;
  try {
    const data = await linearGraphql<AgentSessionQueryResult>(
      accessToken,
      `query AgentSessionIssue($id: String!) {
        agentSession(id: $id) {
          issue {
            id
            team { id }
            state { type }
            delegate { id }
          }
        }
      }`,
      { id: action.agentSessionId },
    );
    const issue = data.agentSession?.issue;
    const issueId = issue?.id;
    const teamId = issue?.team?.id;
    if (!issueId || !teamId) return;

    const input: Record<string, unknown> = {};
    const stateType = issue.state?.type;
    if (stateType !== "started" && stateType !== "completed" && stateType !== "canceled") {
      const stateData = await linearGraphql<{
        team?: { states?: { nodes?: { id: string; position?: number }[] } };
      }>(
        accessToken,
        `query TeamStartedStatuses($teamId: String!) {
          team(id: $teamId) {
            states(filter: { type: { eq: "started" } }) {
              nodes { id position }
            }
          }
        }`,
        { teamId },
      );
      const started = (stateData.team?.states?.nodes ?? [])
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
      if (started?.id) input.stateId = started.id;
    }

    if (!issue.delegate?.id) {
      input.delegateId = action.linearUserId;
    }

    if (Object.keys(input).length === 0) return;
    await linearGraphql(
      accessToken,
      `mutation UpdateIssueForAgent($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id: issueId, input },
    );
  } catch (err) {
    // Best-practice alignment should not block the agent from replying.
    api.logger.error(`[linear] Best-practice issue alignment skipped: ${formatErrorMessage(err)}`);
  }
}

async function dispatchAgentSessionAction(
  action: RouterAction,
  api: OpenClawPluginApi,
): Promise<void> {
  if (!action.agentSessionId) return;
  const active = getOrCreateActiveAgentSession(action);
  if (active.cancelled) {
    api.logger.info(`[linear] Agent Session ${action.agentSessionId} skipped: stop already requested`);
    return;
  }

  try {
    const core = api.runtime;
    const cfg = api.config;
    const accessToken = await getValidAccessToken(api.logger);
    if (!accessToken) {
      api.logger.info("[linear] Agent Session skipped: jojo Linear credentials not found");
      return;
    }
    if (active.cancelled) return;

    const startedBody = action.event === "agent_session.prompted"
      ? "收到你的补充信息了，我继续处理。"
      : "收到，我开始处理。";

    await createAgentActivity(
      action.agentSessionId,
      { type: "thought", body: startedBody },
      api,
    );
    if (active.cancelled) return;

    alignIssueWithAgentBestPractices(action, accessToken, api).catch((err) => {
      api.logger.error(`[linear] Best-practice alignment failed: ${formatErrorMessage(err)}`);
    });

    const sessionContext = await fetchAgentSessionContext(action, accessToken, api).catch((err) => {
      api.logger.error(`[linear] Agent Session context fetch failed: ${formatErrorMessage(err)}`);
      return {
        conversationText: action.promptContext || action.detail,
        mediaPaths: [],
        mediaTypes: [],
      } satisfies AgentSessionContext;
    });
    if (active.cancelled) return;

    const body = [
      "You are responding to a Linear Agent Session.",
      "",
      `Issue: ${action.issueLabel}`,
      `Agent session ID: ${action.agentSessionId}`,
      "",
      sessionContext.conversationText,
      sessionContext.mediaPaths.length > 0
        ? `Attached Linear file(s) have been downloaded and provided as media inputs: ${sessionContext.mediaPaths.map((p) => p.split("/").pop()).join(", ")}`
        : "",
      "",
      "Reply with the final answer for the Linear user. Do not use the linear_comment tool for this session; your final reply will be sent back as a Linear Agent Activity response.",
    ].join("\n");

    const ctx = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: body,
      RawBody: body,
      CommandBody: body,
      ...(sessionContext.mediaPaths.length > 0
        ? {
            MediaPaths: sessionContext.mediaPaths,
            MediaPath: sessionContext.mediaPaths[0],
            MediaTypes: sessionContext.mediaTypes,
            MediaType: sessionContext.mediaTypes[0],
          }
        : {}),
      From: `${CHANNEL_ID}:agent-session:${action.agentSessionId}`,
      To: `${CHANNEL_ID}:${action.agentId}`,
      SessionKey: active.sessionKey,
      AccountId: "default",
      ChatType: "direct",
      ConversationLabel: `Linear Agent Session: ${action.issueLabel}`,
      SenderId: action.linearUserId,
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: `${CHANNEL_ID}:agent-session:${action.agentSessionId}`,
    });

    let deliveredFinal = false;
    const dispatchStartedAtMs = Date.now();
    const agentSessionReplyOptions = {
      sourceReplyDeliveryMode: "automatic",
      abortSignal: active.abortController.signal,
    } as unknown as NonNullable<
      Parameters<typeof core.channel.reply.dispatchReplyWithBufferedBlockDispatcher>[0]["replyOptions"]
    >;

    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      replyOptions: agentSessionReplyOptions,
      dispatcherOptions: {
        deliver: async (payload, info) => {
          if (active.cancelled || info.kind !== "final") return;
          const text = payload.text?.trim();
          if (!text || text === "NO_REPLY") return;
          deliveredFinal = true;
          await createAgentActivity(
            action.agentSessionId!,
            { type: payload.isError ? "error" : "response", body: text },
            api,
          );
        },
        onError: (err: unknown) => {
          if (active.cancelled) return;
          api.logger.error(
            `[linear] Agent Session reply error: ${formatErrorMessage(err)}`,
          );
        },
      },
    });

    if (active.cancelled || deliveredFinal) return;
    const recoveredFinal = await recoverAgentSessionFinalFromLogs(
      action,
      dispatchStartedAtMs,
      api,
    );
    if (active.cancelled) return;
    if (recoveredFinal) {
      await createAgentActivity(
        action.agentSessionId,
        { type: "response", body: recoveredFinal },
        api,
      );
      return;
    }

    await createAgentActivity(
      action.agentSessionId,
      { type: "error", body: "我这边没有生成可发送的最终回复，请再试一次或直接在评论里补充信息。" },
      api,
    );
  } catch (err) {
    if (active.cancelled) {
      api.logger.info(`[linear] Agent Session ${action.agentSessionId} stopped before completion`);
      return;
    }
    throw err;
  } finally {
    clearActiveAgentSession(action, active);
  }
}

async function dispatchAgentSessionCancel(
  action: RouterAction,
  api: OpenClawPluginApi,
): Promise<void> {
  if (!action.agentSessionId) return;
  const active = markAgentSessionCancelled(action);
  if (!active) return;

  api.logger.info(
    `[linear] Agent Session ${action.agentSessionId} stop requested; cancelling ${active.sessionKey}`,
  );

  const core = api.runtime;
  const cfg = api.config;
  const body = "/stop";
  const ctx = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    BodyForCommands: body,
    CommandAuthorized: true,
    CommandTargetSessionKey: active.sessionKey,
    From: `${CHANNEL_ID}:agent-session:${action.agentSessionId}`,
    To: `${CHANNEL_ID}:${action.agentId}`,
    SessionKey: active.sessionKey,
    AccountId: "default",
    ChatType: "direct",
    ConversationLabel: `Linear Agent Session: ${action.issueLabel}`,
    SenderId: action.linearUserId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:agent-session:${action.agentSessionId}`,
    MessageSid: `agent-session-stop:${action.agentSessionId}:${Date.now()}`,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async () => {},
      onError: (err: unknown) => {
        api.logger.error(
          `[linear] Agent Session cancel dispatch error: ${formatErrorMessage(err)}`,
        );
      },
    },
  });
}

let activeDebouncer: { flushKey: (key: string) => Promise<void> } | undefined;
const activeDebouncerKeys = new Set<string>();

export function activate(api: OpenClawPluginApi): void {
  api.logger.info("Linear plugin activated");

  const linearApiKey = api.pluginConfig?.["apiKey"];
  if (typeof linearApiKey !== "string" || !linearApiKey) {
    api.logger.error("[linear] apiKey is not configured — plugin is inert");
    return;
  }

  const webhookSecret = api.pluginConfig?.["webhookSecret"];
  if (typeof webhookSecret !== "string" || !webhookSecret) {
    api.logger.error("[linear] webhookSecret is not configured — plugin is inert");
    return;
  }

  const agentMapping =
    (api.pluginConfig?.["agentMapping"] as Record<string, string>) ?? {};
  if (Object.keys(agentMapping).length === 0) {
    api.logger.info("[linear] agentMapping is empty — all events will be dropped");
  }

  const eventFilter =
    (api.pluginConfig?.["eventFilter"] as string[]) ?? [];
  const teamIds =
    (api.pluginConfig?.["teamIds"] as string[]) ?? [];
  const rawDebounceMs = api.pluginConfig?.["debounceMs"] as number | undefined;
  const debounceMs =
    (typeof rawDebounceMs === "number" && rawDebounceMs > 0)
      ? rawDebounceMs
      : DEFAULT_DEBOUNCE_MS;

  const core = api.runtime;
  const cfg = api.config;

  const queuePath = process.env.HOME
    ? `${process.env.HOME}/.openclaw/openclaw-linear/queue/inbox.jsonl`
    : api.resolvePath("queue/inbox.jsonl");
  const queue = new InboxQueue(queuePath);

  // Recover any stale in_progress items from a previous crash
  queue.recover().then((count) => {
    if (count > 0) {
      api.logger.info(`[linear] Recovered ${count} stale in_progress queue item(s)`);
    }
  }).catch((err) => {
    api.logger.error(
      `[linear] Queue recovery failed: ${formatErrorMessage(err)}`,
    );
  });

  api.registerTool(createQueueTool(queue));
  api.registerTool(createIssueTool());
  api.registerTool(createCommentTool());
  api.registerTool(createTeamTool());
  api.registerTool(createProjectTool());
  api.registerTool(createRelationTool());

  // Auto-wake: after a "complete" action, dispatch a fresh session if items remain
  api.on("after_tool_call", async (event) => {
    if (event.toolName !== "linear_queue") return;
    if (event.params.action !== "complete") return;
    if (event.error) return;

    const remaining = await queue.peek();
    if (remaining.length === 0) return;

    const remainingCount = remaining.length;
    const peerId = `queue-wake-${Date.now()}`;
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId: "default",
      peer: { kind: "direct" as const, id: peerId },
    });

    const body = `${remainingCount} item(s) remaining in queue. Use the linear_queue tool to continue processing.`;

    const ctx = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: body,
      RawBody: body,
      CommandBody: body,
      From: `${CHANNEL_ID}:${peerId}`,
      To: `${CHANNEL_ID}:${route.agentId ?? "default"}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId ?? "default" ,
      ChatType: "direct",
      ConversationLabel: `Linear: queue check (${remainingCount} remaining)`,
      SenderId: peerId,
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: `${CHANNEL_ID}:${peerId}`,
    });

    core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        deliver: async () => {},
        onError: (err: unknown) => {
          api.logger.error(
            `[linear] Queue wake error: ${formatErrorMessage(err)}`,
          );
        },
      },
    }).catch((err) => {
      api.logger.error(
        `[linear] Queue wake dispatch failed: ${formatErrorMessage(err)}`,
      );
    });
  });

  const stateActions =
    (api.pluginConfig?.["stateActions"] as Record<string, string>) ?? undefined;

  const routeEvent = createEventRouter({
    agentMapping,
    logger: api.logger,
    eventFilter: eventFilter.length ? eventFilter : undefined,
    teamIds: teamIds.length ? teamIds : undefined,
    stateActions,
    routeCommentMentions: api.pluginConfig?.["routeCommentMentions"] === true,
    agentSessionAgentId: (api.pluginConfig?.["agentSessionAgentId"] as string | undefined) ?? "linear_jojo_agent",
  });

  const debouncer = api.runtime.channel.debounce.createInboundDebouncer<RouterAction>({
    debounceMs,
    buildKey: (action) => action.agentId,
    shouldDebounce: () => true,
    onFlush: async (actions) => {
      await dispatchConsolidatedActions(actions, api, queue);
    },
    onError: (err) => {
      api.logger.error(
        `[linear] Debounce flush failed: ${formatErrorMessage(err)}`,
      );
    },
  });
  activeDebouncer = debouncer;

  // Lazy init flag: ensures token refresh + scheduler run once
  let initialized = false;
  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    initialized = true;
    const jojoAgentAccessToken = await getValidAccessToken(api.logger);
    setApiKey((jojoAgentAccessToken ?? linearApiKey) as string);
    if (jojoAgentAccessToken) {
      api.logger.info("[linear] Linear GraphQL tools using jojo agent OAuth credentials");
    } else {
      api.logger.info("[linear] Linear GraphQL tools using plugin apiKey fallback");
    }
    scheduleProactiveRefresh(api.logger);
  }

  const handler = createWebhookHandler({
    webhookSecret,
    logger: api.logger,
    onEvent: (event) => {
      const actions = routeEvent(event);
      if (actions.length === 0) {
        api.logger.info(
          `[event-router] no actions for ${event.action} ${event.type} (${String(event.data.id ?? event.data.agentSessionId ?? "unknown")})`,
        );
      }
      for (const action of actions) {
        api.logger.info(
          `[event-router] ${action.type} agent=${action.agentId} event=${action.event}: ${action.detail}`,
        );

        if (action.type === "cancel") {
          dispatchAgentSessionCancel(action, api).catch((err) => {
            api.logger.error(
              `[linear] Agent Session cancel failed: ${formatErrorMessage(err)}`,
            );
          });
          continue;
        }

        if (action.type === "wake") {
          if (action.agentSessionId) {
            // For agent sessions, ensure token is valid first (async lazy init)
            ensureInitialized().then(() =>
              dispatchAgentSessionAction(action, api).catch((err) => {
                api.logger.error(
                  `[linear] Agent Session dispatch failed: ${formatErrorMessage(err)}`,
                );
                if (!isAgentSessionCancelled(action)) {
                  createAgentActivity(
                    action.agentSessionId!,
                    { type: "error", body: `处理失败：${formatErrorMessage(err)}` },
                    api,
                  ).catch((activityErr) => {
                    api.logger.error(
                      `[linear] Agent Session error activity failed: ${formatErrorMessage(activityErr)}`,
                    );
                  });
                }
              })
            );
            continue;
          }

          acknowledgeMention(action, api).catch((err) => {
            api.logger.error(
              `[linear] ACK reaction failed: ${formatErrorMessage(err)}`,
            );
          });

          dispatchConsolidatedActions([action], api, queue).catch((err) => {
            api.logger.error(
              `[linear] Immediate dispatch failed: ${formatErrorMessage(err)}`,
            );
          });
        }

        if (action.type === "notify") {
          queue
            .enqueue([
              {
                id: action.commentId || action.identifier,
                issueId: action.identifier,
                event: action.event,
                summary: action.issueLabel,
                issuePriority: action.issuePriority,
              },
            ])
            .catch((err) =>
              api.logger.error(
                `[linear] Notify enqueue error: ${formatErrorMessage(err)}`,
              ),
            );
        }
      }
    },
  });

  const routePath =
    typeof api.pluginConfig?.["webhookPath"] === "string" &&
    (api.pluginConfig["webhookPath"] as string).trim()
      ? (api.pluginConfig["webhookPath"] as string).trim()
      : "/linear/webhook";

  api.registerHttpRoute({
    path: routePath,
    handler: async (req, res) => {
      await ensureInitialized();
      await handler(req, res);
      return true;
    },
    auth: "plugin",
  });

  api.logger.info(
    `Linear webhook handler registered at ${routePath} (debounce: ${debounceMs}ms)`,
  );
}

export async function deactivate(api: OpenClawPluginApi): Promise<void> {
  if (activeDebouncer) {
    for (const key of activeDebouncerKeys) {
      await activeDebouncer.flushKey(key);
    }
    activeDebouncerKeys.clear();
    activeDebouncer = undefined;
  }
  api.logger.info("Linear plugin deactivated");
}

const plugin = {
  id: "openclaw-linear",
  name: "Linear",
  description: "Linear project management integration for OpenClaw",
  activate,
  deactivate,
} satisfies {
  id: string;
  name: string;
  description: string;
  activate: (api: OpenClawPluginApi) => void;
  deactivate: (api: OpenClawPluginApi) => Promise<void>;
};

export default plugin;
