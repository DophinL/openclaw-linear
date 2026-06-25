import { describe, it, expect, vi } from "vitest";
import { createEventRouter } from "../src/event-router.js";
import type { LinearWebhookPayload } from "../src/webhook-handler.js";
import type { EventRouterConfig } from "../src/event-router.js";

function makeConfig(
  agentMapping: Record<string, string> = {
    "user-1": "agent-1",
    "user-2": "agent-2",
  },
  overrides?: Partial<EventRouterConfig>,
): EventRouterConfig {
  return {
    agentMapping,
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("event-router", () => {
  describe("assignment changes (updatedFrom)", () => {
    it("routes new assignment as wake event", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: { id: "issue-123", assigneeId: "user-1" },
        updatedFrom: { assigneeId: null },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([
        {
          type: "wake",
          agentId: "agent-1",
          event: "issue.assigned",
          detail: "Assigned to issue issue-123",
          issueId: "issue-123",
          issueLabel: "issue-123",
          identifier: "issue-123",
          issuePriority: 0,
          linearUserId: "user-1",
        },
      ]);
    });

    it("includes issue identifier and title in detail when available", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-123",
          identifier: "ENG-42",
          title: "Fix login bug",
          assigneeId: "user-1",
        },
        updatedFrom: { assigneeId: null },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions[0].detail).toBe("Assigned to issue ENG-42: Fix login bug");
      expect(actions[0].issueLabel).toBe("ENG-42: Fix login bug");
      expect(actions[0].identifier).toBe("ENG-42");
      expect(actions[0].issuePriority).toBe(0);
    });

    it("routes unassignment as notify event", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: { id: "issue-456", assigneeId: null },
        updatedFrom: { assigneeId: "user-2" },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([
        {
          type: "notify",
          agentId: "agent-2",
          event: "issue.unassigned",
          detail: "Unassigned from issue issue-456",
          issueId: "issue-456",
          issueLabel: "issue-456",
          identifier: "issue-456",
          issuePriority: 0,
          linearUserId: "user-2",
        },
      ]);
    });

    it("notifies old assignee on reassignment", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: { id: "issue-789", assigneeId: "user-1" },
        updatedFrom: { assigneeId: "user-2" },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(2);

      // New assignee gets wake
      expect(actions[0]).toMatchObject({
        type: "wake",
        agentId: "agent-1",
        event: "issue.assigned",
        identifier: "issue-789",
        issuePriority: 0,
        linearUserId: "user-1",
      });

      // Old assignee gets notify
      expect(actions[1]).toMatchObject({
        type: "notify",
        agentId: "agent-2",
        event: "issue.reassigned",
        identifier: "issue-789",
        issuePriority: 0,
        linearUserId: "user-2",
      });
    });

    it("returns empty when update has no updatedFrom", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: { id: "issue-no-changes", assigneeId: "user-1" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });
  });

  describe("issue create", () => {
    it("routes create with assignee as wake event", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "create",
        data: {
          id: "issue-new",
          identifier: "ENG-99",
          title: "New feature",
          assigneeId: "user-1",
          priority: 2,
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([
        {
          type: "wake",
          agentId: "agent-1",
          event: "issue.assigned",
          detail: "Assigned to issue ENG-99: New feature",
          issueId: "issue-new",
          issueLabel: "ENG-99: New feature",
          identifier: "ENG-99",
          issuePriority: 2,
          linearUserId: "user-1",
        },
      ]);
    });

    it("returns empty for create without assignee", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "create",
        data: { id: "issue-unassigned" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });

    it("logs unmapped user on create with assignee", () => {
      const config = makeConfig({});
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "create",
        data: { id: "issue-unk", assigneeId: "unknown-user" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
      expect(config.logger.info).toHaveBeenCalledWith(
        "Unmapped Linear user unknown-user assigned to issue-unk",
      );
    });
  });

  describe("issue remove", () => {
    it("routes remove with assignee as notify event", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "remove",
        data: {
          id: "issue-del",
          identifier: "ENG-50",
          title: "Old issue",
          assigneeId: "user-1",
          priority: 3,
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([
        {
          type: "notify",
          agentId: "agent-1",
          event: "issue.removed",
          detail: "Issue ENG-50: Old issue removed",
          issueId: "issue-del",
          issueLabel: "ENG-50: Old issue",
          identifier: "ENG-50",
          issuePriority: 3,
          linearUserId: "user-1",
        },
      ]);
    });

    it("returns empty for remove without assignee", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "remove",
        data: { id: "issue-del-2" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });

    it("returns empty for remove with unmapped assignee", () => {
      const config = makeConfig({});
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "remove",
        data: { id: "issue-del-3", assigneeId: "unknown-user" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });
  });

  describe("state changes (configurable)", () => {
    it("default: backlog → wake issue.state_readded", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-back",
          identifier: "ENG-10",
          title: "Bounced task",
          assigneeId: "user-1",
          state: { type: "backlog", name: "Backlog" },
        },
        updatedFrom: { stateId: "state-old" },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: "wake",
        event: "issue.state_readded",
        agentId: "agent-1",
        linearUserId: "user-1",
      });
    });

    it("default: unstarted → wake issue.state_readded", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-todo",
          assigneeId: "user-1",
          state: { type: "unstarted", name: "Todo" },
        },
        updatedFrom: { stateId: "state-old" },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: "wake",
        event: "issue.state_readded",
        agentId: "agent-1",
      });
    });

    it("default: completed → notify issue.state_removed", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-done",
          identifier: "ENG-10",
          title: "Done task",
          assigneeId: "user-1",
          state: { type: "completed", name: "Done" },
        },
        updatedFrom: { stateId: "state-old" },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: "notify",
        event: "issue.state_removed",
        agentId: "agent-1",
        linearUserId: "user-1",
      });
    });

    it("default: canceled → notify issue.state_removed", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-cancel",
          assigneeId: "user-2",
          state: { type: "canceled", name: "Canceled" },
        },
        updatedFrom: { stateId: "state-old" },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: "notify",
        event: "issue.state_removed",
        agentId: "agent-2",
      });
    });

    it("default: started → no action (ignore)", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-progress",
          assigneeId: "user-1",
          state: { type: "started", name: "In Progress" },
        },
        updatedFrom: { stateId: "state-old" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });

    it("custom config: state name overrides type", () => {
      const config = makeConfig(undefined, {
        stateActions: {
          started: "ignore",
          "In Review": "remove",
        },
      });
      const route = createEventRouter(config);

      // "In Review" is a started-type state, but name match takes precedence
      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-review",
          assigneeId: "user-1",
          state: { type: "started", name: "In Review" },
        },
        updatedFrom: { stateId: "state-old" },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: "notify",
        event: "issue.state_removed",
      });
    });

    it("custom config: case-insensitive name match", () => {
      const config = makeConfig(undefined, {
        stateActions: {
          "in review": "remove",
        },
      });
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-review",
          assigneeId: "user-1",
          state: { type: "started", name: "In Review" },
        },
        updatedFrom: { stateId: "state-old" },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: "notify",
        event: "issue.state_removed",
      });
    });

    it("unknown state type → ignore", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-unknown",
          assigneeId: "user-1",
          state: { type: "custom_state", name: "Whatever" },
        },
        updatedFrom: { stateId: "state-old" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });

    it("ignores state change when no assignee", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-no-assignee",
          state: { type: "completed", name: "Done" },
        },
        updatedFrom: { stateId: "state-old" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });
  });

  describe("priority changes", () => {
    it("emits issue.priority_changed when priority changes", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-pri",
          identifier: "ENG-20",
          title: "Priority task",
          assigneeId: "user-1",
          priority: 1,
        },
        updatedFrom: { priority: 3 },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: "notify",
        event: "issue.priority_changed",
        agentId: "agent-1",
        issuePriority: 1,
        linearUserId: "user-1",
      });
    });

    it("ignores priority change when no assignee", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: { id: "issue-pri-2", priority: 1 },
        updatedFrom: { priority: 3 },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });
  });

  describe("combined changes in single event", () => {
    it("emits both assignment and state change actions", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-combo",
          assigneeId: "user-1",
          state: { type: "completed", name: "Done" },
          priority: 1,
        },
        updatedFrom: { assigneeId: null, stateId: "state-old", priority: 3 },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      // assignment + state_removed + priority_changed
      expect(actions).toHaveLength(3);
      expect(actions.map((a) => a.event)).toEqual([
        "issue.assigned",
        "issue.state_removed",
        "issue.priority_changed",
      ]);
    });
  });

  describe("comment mentions", () => {
    it("routes @mention in comment as wake event", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          id: "comment-abc",
          body: "Hey @user-1 can you look at this?",
          issue: { id: "issue-789" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: "wake",
        agentId: "agent-1",
        event: "comment.mention",
        issueId: "issue-789",
        identifier: "issue-789",
        issuePriority: 0,
        linearUserId: "user-1",
        commentId: "comment-abc",
      });
      expect(actions[0].detail).toContain("Mentioned in comment on issue");
      expect(actions[0].detail).toContain("Hey @user-1 can you look at this?");
    });

    it("routes multiple mentions to multiple agents", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "update",
        data: {
          body: "cc @user-1 @user-2",
          issue: { id: "issue-100" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(2);
      expect(actions[0].agentId).toBe("agent-1");
      expect(actions[1].agentId).toBe("agent-2");
    });

    it("extracts mentions from ProseMirror bodyData when available", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Hey John can you look at this?",
          bodyData: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Hey " },
                  {
                    type: "mention",
                    attrs: { id: "user-1", label: "John" },
                  },
                  { type: "text", text: " can you look at this?" },
                ],
              },
            ],
          },
          issue: { id: "issue-300" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        agentId: "agent-1",
        linearUserId: "user-1",
      });
    });

    it("deduplicates mentions from ProseMirror bodyData", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Hey @user-1 and @user-1 again",
          bodyData: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "mention",
                    attrs: { id: "user-1", label: "John" },
                  },
                  { type: "text", text: " and " },
                  {
                    type: "mention",
                    attrs: { id: "user-1", label: "John" },
                  },
                ],
              },
            ],
          },
          issue: { id: "issue-400" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
    });

    it("resolves display name to UUID via reverse lookup when bodyData is missing", () => {
      const config = makeConfig({
        "uuid-abc-123": "juno",
        "uuid-def-456": "titus",
      });
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          id: "comment-reverse",
          body: "Hey @juno can you look at this?",
          issue: { id: "issue-600", identifier: "ENG-60", title: "Test" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: "wake",
        agentId: "juno",
        event: "comment.mention",
        linearUserId: "uuid-abc-123",
        commentId: "comment-reverse",
      });
    });

    it("resolves display name case-insensitively via reverse lookup", () => {
      const config = makeConfig({
        "uuid-abc-123": "Juno",
      });
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          id: "comment-case",
          body: "Hey @juno check this",
          issue: { id: "issue-601" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0].linearUserId).toBe("uuid-abc-123");
    });

    it("resolves multiple display names via reverse lookup when bodyData is empty", () => {
      const config = makeConfig({
        "uuid-abc-123": "juno",
        "uuid-def-456": "titus",
      });
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          id: "comment-multi",
          body: "cc @juno @titus",
          bodyData: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "cc @juno @titus" }],
              },
            ],
          },
          issue: { id: "issue-602" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(2);
      expect(actions[0].linearUserId).toBe("uuid-abc-123");
      expect(actions[1].linearUserId).toBe("uuid-def-456");
    });

    it("falls back to regex when bodyData has no mentions", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Hey @user-1 check this",
          bodyData: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Hey @user-1 check this" }],
              },
            ],
          },
          issue: { id: "issue-500" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0].agentId).toBe("agent-1");
    });
  });

  describe("unmapped users", () => {
    it("logs unmapped user on assignment and returns no actions", () => {
      const config = makeConfig({});
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: { id: "issue-999", assigneeId: "unknown-user" },
        updatedFrom: { assigneeId: null },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([]);
      expect(config.logger.info).toHaveBeenCalledWith(
        "Unmapped Linear user unknown-user assigned to issue-999",
      );
    });

    it("logs unmapped user on comment mention and returns no actions", () => {
      const config = makeConfig({});
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Hey @unknown-user check this",
          issue: { id: "issue-500" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([]);
      expect(config.logger.info).toHaveBeenCalledWith(
        "Unmapped Linear user unknown-user mentioned in comment on issue-500",
      );
    });
  });

  describe("self-comment skip", () => {
    it("skips comments authored by a mapped agent (user field)", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          id: "comment-self-1",
          body: "Hey @user-2 what do you think?",
          user: { id: "user-1" },
          issue: { id: "issue-600" },
        },
        createdAt: new Date().toISOString(),
      };

      // user-1 is a mapped agent, so this comment should be skipped
      const actions = route(event);
      expect(actions).toEqual([]);
      expect(config.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Skipping self-comment from agent agent-1"),
      );
    });

    it("skips comments authored by a mapped agent (userId field)", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          id: "comment-self-2",
          body: "Hey @user-2 thoughts?",
          userId: "user-1",
          issue: { id: "issue-601" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([]);
    });

    it("does not skip comments from non-agent users", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          id: "comment-human",
          body: "Hey @user-1 can you check?",
          user: { id: "human-user-123" },
          issue: { id: "issue-602" },
        },
        createdAt: new Date().toISOString(),
      };

      // human-user-123 is NOT in agentMapping, so the comment should be routed
      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0].agentId).toBe("agent-1");
    });
  });

  describe("unrelated events", () => {
    it("returns empty for non-issue non-comment events", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Project",
        action: "create",
        data: { id: "proj-1" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });
  });

  describe("event filtering", () => {
    it("filters out events not in eventFilter", () => {
      const config = makeConfig(
        { "user-1": "agent-1" },
        { eventFilter: ["Comment"] },
      );
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: { id: "issue-1", assigneeId: "user-1" },
        updatedFrom: { assigneeId: null },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });

    it("allows events matching eventFilter", () => {
      const config = makeConfig(
        { "user-1": "agent-1" },
        { eventFilter: ["Issue"] },
      );
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: { id: "issue-1", assigneeId: "user-1" },
        updatedFrom: { assigneeId: null },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toHaveLength(1);
    });
  });

  describe("team filtering", () => {
    it("filters out events from non-matching teams by teamId", () => {
      const config = makeConfig(
        { "user-1": "agent-1" },
        { teamIds: ["team-eng"] },
      );
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-1",
          teamId: "team-ops",
          assigneeId: "user-1",
        },
        updatedFrom: { assigneeId: null },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });

    it("allows events from matching teams by team key", () => {
      const config = makeConfig(
        { "user-1": "agent-1" },
        { teamIds: ["ENG"] },
      );
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-1",
          team: { key: "ENG" },
          assigneeId: "user-1",
        },
        updatedFrom: { assigneeId: null },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toHaveLength(1);
    });

    it("allows events when no team info is present (cannot filter)", () => {
      const config = makeConfig(
        { "user-1": "agent-1" },
        { teamIds: ["ENG"] },
      );
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: { id: "issue-1", assigneeId: "user-1" },
        updatedFrom: { assigneeId: null },
        createdAt: new Date().toISOString(),
      };

      // No team info on event → can't filter → allow through
      expect(route(event)).toHaveLength(1);
    });
  });

  describe("agent session events", () => {
    it("routes created AgentSessionEvent to configured OpenClaw agent", () => {
      const config = makeConfig({}, { agentSessionAgentId: "linear_jojo_agent" });
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "AgentSessionEvent",
        action: "created",
        data: {
          appUserId: "app-user-1",
          promptContext: "<issue identifier=\"YOU-1\"><title>Help</title></issue>",
          agentSession: {
            id: "session-1",
            issue: {
              id: "issue-1",
              identifier: "YOU-1",
              title: "Help",
              priority: 2,
            },
            comment: { id: "comment-1" },
          },
        },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([
        {
          type: "wake",
          agentId: "linear_jojo_agent",
          event: "agent_session.created",
          detail: "Linear Agent Session created on YOU-1: Help\n\n<issue identifier=\"YOU-1\"><title>Help</title></issue>",
          issueId: "issue-1",
          issueLabel: "YOU-1: Help",
          identifier: "YOU-1",
          issuePriority: 2,
          linearUserId: "app-user-1",
          commentId: "comment-1",
          agentSessionId: "session-1",
          promptContext: "<issue identifier=\"YOU-1\"><title>Help</title></issue>",
        },
      ]);
    });

    it("routes prompted AgentSessionEvent with prompt body", () => {
      const config = makeConfig({ "app-user-1": "agent-1" });
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "AgentSessionEvent",
        action: "prompted",
        data: {
          agentSession: {
            id: "session-2",
            issue: { id: "issue-2", identifier: "YOU-2" },
          },
          agentActivity: {
            content: { type: "prompt", body: "继续" },
          },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: "wake",
        agentId: "agent-1",
        event: "agent_session.prompted",
        agentSessionId: "session-2",
        detail: "Linear Agent Session prompted on YOU-2\n\n继续",
      });
    });

    it("routes OAuth App AgentSession create payloads", () => {
      const config = makeConfig({}, { agentSessionAgentId: "linear_jojo_agent" });
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "AgentSession",
        action: "create",
        data: {
          id: "session-3",
          promptContext: "<issue identifier=\"YOU-3\"><title>OAuth app session</title></issue>",
        },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([
        expect.objectContaining({
          type: "wake",
          agentId: "linear_jojo_agent",
          event: "agent_session.created",
          issueId: "agent-session:session-3",
          issueLabel: "agent-session:session-3",
          identifier: "agent-session:session-3",
          agentSessionId: "session-3",
          promptContext: "<issue identifier=\"YOU-3\"><title>OAuth app session</title></issue>",
        }),
      ]);
    });

    it.each(["cancelled", "canceled", "cancel", "stop", "stopped"])(
      "routes %s AgentSessionEvent to cancel the active OpenClaw session",
      (action) => {
        const config = makeConfig({}, { agentSessionAgentId: "linear_jojo_agent" });
        const route = createEventRouter(config);

        const event: LinearWebhookPayload = {
          type: "AgentSessionEvent",
          action,
          data: {
            appUserId: "app-user-1",
            agentSession: {
              id: "session-stop",
              issue: {
                id: "issue-stop",
                identifier: "YOU-STOP",
                title: "Stop test",
              },
            },
          },
          createdAt: new Date().toISOString(),
        };

        expect(route(event)).toEqual([
          expect.objectContaining({
            type: "cancel",
            agentId: "linear_jojo_agent",
            event: "agent_session.cancelled",
            detail: "Linear Agent Session stop requested on YOU-STOP: Stop test",
            issueId: "issue-stop",
            issueLabel: "YOU-STOP: Stop test",
            identifier: "YOU-STOP",
            agentSessionId: "session-stop",
          }),
        ]);
      },
    );

    it("can disable legacy comment mention routing when AgentSession events are preferred", () => {
      const config = makeConfig({ "user-1": "agent-1" }, { routeCommentMentions: false });
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: { id: "comment-1", body: "@agent-1 hello", issue: { id: "issue-1" } },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });
  });
});
