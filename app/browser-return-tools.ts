export type BrowserTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

export type BrowserModelContext = {
  registerTool: (
    tool: BrowserTool,
    options: { signal: AbortSignal },
  ) => unknown;
};

// Own only this registration batch. Never clear another app's browser tools.
// AbortSignal is the current WebMCP lifecycle API; unregisterTool is obsolete.
export function registerBrowserReturnTools(
  context: BrowserModelContext | undefined,
  tools: BrowserTool[],
  onStatus: (status: "unavailable" | "ready" | "failed") => void,
) {
  if (!context?.registerTool) {
    onStatus("unavailable");
    return () => {};
  }
  const controller = new AbortController();
  let disposed = false;
  void (async () => {
    try {
      for (const tool of tools) {
        if (disposed) return;
        await context.registerTool(tool, { signal: controller.signal });
      }
      if (!disposed) onStatus("ready");
    } catch {
      controller.abort();
      if (!disposed) onStatus("failed");
    }
  })();
  return () => {
    disposed = true;
    controller.abort();
  };
}

export function returnSessionTool(info: {
  shop: string;
  authenticated: boolean;
  loginUrl: string;
  resume?: (input: Record<string, unknown>) => Promise<unknown>;
}): BrowserTool {
  return {
    name: "get_return_session",
    title: "Check customer verification for this return",
    description:
      "Check customer verification and resume the signed-in customer's return draft, quote expiry, status, and recovery instructions. No Gooper.io connector is needed for these in-page tools. Keep this page loaded while continuing in chat. Sign-in is not refund consent. This never creates a return or sends money.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, consequentialHint: false },
    execute: async () =>
      info.authenticated && info.resume
        ? info.resume({})
        : {
            merchant: info.shop,
            status: info.authenticated
              ? "customer_verified"
              : "verification_required",
            connectorRequired: false,
            browserToolSupportRequired: true,
            authenticationRequired: !info.authenticated,
            ...(!info.authenticated ? { loginUrl: info.loginUrl } : {}),
            nextTool: info.authenticated ? "find_returnable_items" : null,
            nextStep: info.authenticated
              ? "Find the exact purchased item, obtain a quote, and ask the customer to confirm the exact items and amount before submission."
              : "Let the customer complete Shopify sign-in through the visible link. After returning to this page, discover its tools again and check get_return_session. Never ask for a password or verification code in chat.",
            confirmationRequired: true,
            returnSubmitted: false,
            refundSubmitted: false,
          },
  };
}
