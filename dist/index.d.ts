import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { type RouterAction } from "./event-router.js";
export declare function formatConsolidatedMessage(actions: RouterAction[]): string;
export declare function activate(api: OpenClawPluginApi): void;
export declare function deactivate(api: OpenClawPluginApi): Promise<void>;
declare const plugin: {
    id: string;
    name: string;
    description: string;
    activate: typeof activate;
    deactivate: typeof deactivate;
};
export default plugin;
//# sourceMappingURL=index.d.ts.map