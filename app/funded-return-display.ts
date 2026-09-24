import type { SandboxState } from "./funded-return-sandbox";

export function fundedReturnProgress(state: SandboxState) {
  if (state.collection === "SETTLED")
    return { label: "Gooper return complete", tone: "success" } as const;
  if (["DUE", "PENDING", "FAILED", "UNKNOWN"].includes(state.collection))
    return {
      label: "Completing Gooper return",
      tone:
        state.collection === "FAILED" || state.collection === "UNKNOWN"
          ? "warning"
          : "info",
    } as const;
  if (state.returnStatus === "REJECTED")
    return { label: "Gooper return needs review", tone: "warning" } as const;
  if (state.returnStatus === "RECEIVED")
    return { label: "Ready to complete", tone: "info" } as const;
  if (state.payout === "SUCCEEDED")
    return { label: "Refund paid by Gooper", tone: "success" } as const;
  if (state.payout === "FAILED" || state.payout === "UNKNOWN")
    return { label: "Gooper payment needs review", tone: "warning" } as const;
  if (state.payout === "PENDING")
    return { label: "Gooper payment in progress", tone: "info" } as const;
  return { label: "Not funded yet", tone: "neutral" } as const;
}

export function dashboardFundedActionAvailable(
  state: SandboxState,
  action: "RECEIVE_ITEM" | "INSPECT_ITEM",
) {
  return action === "RECEIVE_ITEM"
    ? state.payout === "SUCCEEDED" && state.returnStatus === "AWAITING_RETURN"
    : state.payout === "SUCCEEDED" && state.returnStatus === "RECEIVED";
}
