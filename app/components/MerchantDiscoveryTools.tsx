import { useEffect } from "react";
import {
  registerBrowserReturnTools,
  type BrowserModelContext,
  type BrowserTool,
} from "../browser-return-tools";
export function MerchantDiscoveryTools() {
  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: BrowserModelContext;
      }
    ).modelContext;
    if (window.top !== window || !context?.registerTool) return;
    const inputSchema = {
      type: "object",
      properties: {
        merchant: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description:
            "Only the merchant business name or domain. Never include customer details, item/order information, credentials, or a conversation.",
        },
      },
      required: ["merchant"],
      additionalProperties: false,
    };
    const execute =
      (path: string) => async (input: Record<string, unknown>) => {
        try {
          const response = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(15000),
          });
          const result = await response.json();
          return response.ok ? result : { ...result, isError: true };
        } catch {
          return {
            status: "stopped",
            isError: true,
            nextStep:
              "Stop. Nothing has been submitted. Do not proceed to a return or refund.",
            returnSubmitted: false,
            refundSubmitted: false,
          };
        }
      };
    const tools: BrowserTool[] = [
      {
        name: "find_merchant_return_page",
        description:
          "Find a published Gooper.io merchant by exact business name. Unresolved or ambiguous requests stop and record a minimal private discovery signal for Gooper.io's operator, not the merchant. Do not contact the merchant or substitute another store. If an earlier external search already failed, use report_merchant_discovery_failure instead and stop.",
        inputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
        execute: execute("/api/merchants"),
      },
      {
        name: "report_merchant_discovery_failure",
        description:
          "After the assistant cannot find the requested store, record only its business name/domain for Gooper.io's private operator review and stop. This does not contact the merchant, create a return draft, look up purchases, or issue a refund. Do not continue with a URL fallback after this report.",
        inputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
        execute: execute("/api/merchant-discovery-failure"),
      },
    ];
    return registerBrowserReturnTools(context, tools, () => {});
  }, []);
  return null;
}
