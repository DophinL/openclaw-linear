import type { IncomingMessage, ServerResponse } from "node:http";
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
export declare function createWebhookHandler(deps: WebhookHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export {};
//# sourceMappingURL=webhook-handler.d.ts.map