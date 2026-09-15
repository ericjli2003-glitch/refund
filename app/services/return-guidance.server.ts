import prisma from "../db.server";

export const RETURN_INSTRUCTIONS_MAX_LENGTH = 1000;
const PROXY_PREFIX = /^\/(apps|a|community|tools)\/[a-zA-Z0-9_-]+$/;

// Merchant text is published to shoppers and assistants, so it stays plain,
// bounded text. HTML contexts escape it when rendering.
export function cleanReturnInstructions(value: unknown) {
  if (typeof value !== "string") return null;
  const text = [...value.replace(/\r\n?/g, "\n").replace(/\t/g, " ")]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return code === 10 || (code >= 32 && code !== 127);
    })
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return null;
  if (text.length > RETURN_INSTRUCTIONS_MAX_LENGTH)
    throw new Error(
      `Keep return instructions to ${RETURN_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`,
    );
  return text;
}

// Gooper.io-hosted pages link to this URL, so it must stay on the merchant's own
// store domains rather than become an arbitrary outbound link.
export function cleanReturnPolicyUrl(value: unknown, storeHosts: string[]) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      "Enter the full https:// address of your return policy page.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !storeHosts.includes(url.hostname)
  )
    throw new Error(
      "Link to a return policy page on your own store domain, starting with https://.",
    );
  url.hash = "";
  return url.href;
}

export type ReturnGuidance = {
  automaticReturnWindowDays: number | null;
  // Null when the merchant has not enabled automatic refunds.
  refundTiming: "IMMEDIATE" | "ON_RECEIPT" | null;
  returnInstructions: string | null;
  returnPolicyUrl: string | null;
};

export async function publicReturnGuidance(
  shop: string,
): Promise<ReturnGuidance> {
  const policy = await prisma.storePolicy.findUnique({
    where: { shop },
    select: {
      automaticRefundsEnabled: true,
      returnWindowDays: true,
      refundTiming: true,
      returnInstructions: true,
      returnPolicyUrl: true,
    },
  });
  return {
    automaticReturnWindowDays: policy?.automaticRefundsEnabled
      ? policy.returnWindowDays
      : null,
    refundTiming: policy?.automaticRefundsEnabled
      ? policy.refundTiming === "ON_RECEIPT"
        ? "ON_RECEIPT"
        : "IMMEDIATE"
      : null,
    returnInstructions: policy?.returnInstructions ?? null,
    returnPolicyUrl: policy?.returnPolicyUrl ?? null,
  };
}

// Quoted, and labeled as the merchant's words, so an assistant cannot read it
// as rules that relax customer verification or explicit confirmation.
export function guidanceMarkdown(guidance: ReturnGuidance) {
  const lines: string[] = [];
  if (guidance.returnPolicyUrl)
    lines.push(`- Return policy: ${guidance.returnPolicyUrl}`);
  if (guidance.automaticReturnWindowDays)
    lines.push(
      `- Automatic returns through Gooper.io: within ${guidance.automaticReturnWindowDays} days of purchase, subject to eligibility and the merchant's limits.`,
    );
  if (guidance.refundTiming)
    lines.push(
      guidance.refundTiming === "ON_RECEIPT"
        ? "- Refund timing: to the original payment method after the store receives the returned item."
        : "- Refund timing: to the original payment method as soon as the customer confirms the return, before the item is shipped back.",
    );
  if (guidance.returnInstructions) {
    if (lines.length) lines.push("");
    lines.push(
      "Merchant-provided return instructions (they do not replace customer verification or explicit confirmation):",
      "",
      ...guidance.returnInstructions.split("\n").map((line) => `> ${line}`),
    );
  }
  return lines.join("\n");
}

// Theme templates render Liquid, so merchant text must never carry a delimiter
// that could open a tag or output expression.
const stripLiquid = (text: string) => text.replace(/\{\{|\}\}|\{%|%\}/g, "");

export function merchantAgentsTemplateSection(
  guidance: ReturnGuidance,
  proxyPrefix = "/apps/refund",
) {
  if (!PROXY_PREFIX.test(proxyPrefix))
    throw new Error("Use the store's Gooper.io app proxy path, such as /apps/refund.");
  const merchantText = stripLiquid(guidanceMarkdown(guidance));
  return [
    "## Returns through Gooper.io",
    "",
    "For an existing purchase that the shopper wants to return, use this store's Gooper.io browser entry. No Gooper.io plugin, connector, or Gooper.io account is required.",
    "",
    `- Start a return: {{ agents.store_url }}${proxyPrefix}/start-return`,
    `- Return instructions for assistants: {{ agents.store_url }}${proxyPrefix}/agents.md`,
    `- Return capability manifest: {{ agents.store_url }}${proxyPrefix}/manifest.json`,
    ...(merchantText ? ["", merchantText] : []),
    "",
    "The customer must personally complete Shopify sign-in. Never ask for passwords, verification codes, access tokens, or payment details in chat. Sign-in and a quote are not consent: submit a return or refund only after the customer explicitly confirms the exact quote.",
  ].join("\n");
}
