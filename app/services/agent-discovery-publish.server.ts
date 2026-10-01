import { AGENTS_STARTER_TEMPLATE as starterTemplate } from "./agents-starter-template";
import { appOrigin } from "./customer-security.server";
import { adminData, type AdminGraphql } from "./shopify-admin.server";
import {
  merchantAgentsTemplateSection,
  type ReturnGuidance,
} from "./return-guidance.server";

// Gooper.io writes two things a merchant opts into from the dashboard, so AI
// assistants learn that the store's returns go through Gooper.io: a section
// of the live theme's agents.md template, and a paragraph of the refund
// policy. Each is fenced so it can be refreshed or removed without touching
// the merchant's own text. Both scopes are optional and requested only when
// the merchant clicks the button.
export const AGENTS_THEME_SCOPE = "write_themes";
export const REFUND_POLICY_SCOPE = "write_legal_policies";
export const AGENTS_TEMPLATE = "templates/agents.md.liquid";

// Liquid comments: they fence the section in the template without appearing
// in the /agents.md that assistants read.
const SECTION_START_PREFIX = "{% comment %}gooper.io returns: start";
const SECTION_START = `${SECTION_START_PREFIX}. Gooper.io keeps this section current from its dashboard; edits inside it are replaced.{% endcomment %}`;
const SECTION_END = "{% comment %}gooper.io returns: end{% endcomment %}";
// A Returns section pasted before the button existed, or the starter's own.
const PASTED_SECTION = /^## Returns through (?:Gooper\.io|Refund)[ \t]*$/m;

export class DiscoveryPermissionError extends Error {
  constructor(public scope: string, message: string) {
    super(message);
  }
}

function fenced(section: string) {
  return `${SECTION_START}\n${section}\n${SECTION_END}`;
}

function sectionBounds(template: string) {
  const start = template.indexOf(SECTION_START_PREFIX);
  const end = template.indexOf(SECTION_END, start);
  return start >= 0 && end > start
    ? { start, end: end + SECTION_END.length }
    : null;
}

// From a pasted heading to the next second-level heading, or the end.
function pastedBounds(template: string) {
  const match = PASTED_SECTION.exec(template);
  if (!match) return null;
  const rest = template.slice(match.index + match[0].length);
  const next = /^## /m.exec(rest);
  return {
    start: match.index,
    end: match.index + match[0].length + (next ? next.index : rest.length),
  };
}

// The template with Gooper.io's section added or refreshed. Without a template,
// Shopify serves its own default guide, so the starter keeps those shopping
// sections. A section pasted by hand is replaced rather than duplicated.
// Otherwise the section goes right after the title, where assistants read
// first, and the merchant's text is left as it was.
export function templateWithGooperSection(
  existing: string | null,
  section: string,
) {
  const block = fenced(section);
  if (!existing?.trim()) {
    const bounds = pastedBounds(starterTemplate)!;
    return (
      starterTemplate.slice(0, bounds.start) +
      block +
      "\n\n" +
      starterTemplate.slice(bounds.end)
    );
  }
  const bounds = sectionBounds(existing);
  if (bounds)
    return existing.slice(0, bounds.start) + block + existing.slice(bounds.end);
  const pasted = pastedBounds(existing);
  if (pasted)
    return (
      existing.slice(0, pasted.start) +
      block +
      "\n\n" +
      existing.slice(pasted.end).replace(/^\n+/, "")
    );
  const lines = existing.split("\n");
  const title = lines.findIndex((line) => /^# /.test(line));
  if (title < 0) return `${block}\n\n${existing}`;
  // After the title and the paragraph that introduces the store.
  let at = title + 1;
  while (at < lines.length && !lines[at].trim()) at++;
  if (at < lines.length && !lines[at].startsWith("#"))
    while (at < lines.length && lines[at].trim()) at++;
  const before = lines.slice(0, at).join("\n").trimEnd();
  const after = lines.slice(at).join("\n").replace(/^\s+/, "");
  return `${before}\n\n${block}\n\n${after}`.trimEnd() + "\n";
}

// The template without Gooper.io's section, or null when nothing else is left
// (deleting the file then restores Shopify's default guide).
export function templateWithoutGooperSection(existing: string) {
  const bounds = sectionBounds(existing);
  if (!bounds) return existing;
  const rest =
    existing.slice(0, bounds.start).trimEnd() +
    "\n\n" +
    existing.slice(bounds.end).replace(/^\s+/, "");
  return rest.trim() ? rest.trimEnd() + "\n" : null;
}

export const hasGooperSection = (template: string | null | undefined) =>
  Boolean(template && sectionBounds(template));

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );

// The refund policy paragraph, found again by its opening words. Shopify's
// policy editor keeps paragraphs and links but may drop attributes, so the
// text itself is the marker.
const POLICY_LEAD = "Returns through Gooper.io:";
const POLICY_PARAGRAPH =
  /<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?Returns through Gooper\.io:(?:(?!<\/p>)[\s\S])*?<\/p>\s*/i;

export function refundPolicyParagraph(shop: string) {
  const origin = appOrigin();
  const portal = `${origin}/returns/${shop}`;
  return `<p><strong>${POLICY_LEAD}</strong> This store handles returns and refunds through Gooper.io. Start a return at <a href="${escapeHtml(portal)}">${escapeHtml(portal)}</a>. AI assistants such as ChatGPT or Claude can process the return with the Gooper.io connector at ${escapeHtml(origin)}/mcp for the store ${escapeHtml(shop)}. Refunds go to the original payment method, after the customer confirms the exact items and amount.</p>`;
}

export function policyWithGooperParagraph(body: string, paragraph: string) {
  return POLICY_PARAGRAPH.test(body)
    ? body.replace(POLICY_PARAGRAPH, `${paragraph}\n`)
    : `${paragraph}\n${body}`;
}

export const policyWithoutGooperParagraph = (body: string) =>
  body.replace(POLICY_PARAGRAPH, "");

export const hasGooperParagraph = (body: string | null | undefined) =>
  Boolean(body && POLICY_PARAGRAPH.test(body));

// Shopify reports a missing scope or exemption as a top-level ACCESS_DENIED
// error, which adminData would otherwise turn into a generic failure.
async function adminRequest<T>(
  admin: AdminGraphql,
  query: string,
  variables: Record<string, unknown>,
  failure: string,
  scope: string,
) {
  try {
    return await adminData<T>(admin, query, variables, failure);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/access denied|access_denied|exemption|write_themes|write_legal_policies/i.test(message))
      throw new DiscoveryPermissionError(
        scope,
        scope === AGENTS_THEME_SCOPE
          ? "Shopify hasn't allowed Gooper.io to edit your theme's agents.md yet. Use Copy Returns section for now."
          : "Gooper.io needs your permission to edit store policies.",
      );
    throw error;
  }
}

export async function grantedScopes(admin: AdminGraphql) {
  const data = await adminData<{
    currentAppInstallation: { accessScopes: Array<{ handle: string }> };
  }>(
    admin,
    `#graphql
      query GooperGrantedScopes {
        currentAppInstallation { accessScopes { handle } }
      }`,
    {},
    "Shopify could not read Gooper.io's permissions.",
  );
  return new Set(data.currentAppInstallation.accessScopes.map((scope) => scope.handle));
}

type ThemeFileBody =
  | { __typename: "OnlineStoreThemeFileBodyText"; content: string }
  | { __typename: "OnlineStoreThemeFileBodyBase64"; contentBase64: string }
  | { __typename: string };

async function liveAgentsTemplate(admin: AdminGraphql) {
  const data = await adminRequest<{
    themes: {
      nodes: Array<{
        id: string;
        name: string;
        files: { nodes: Array<{ filename: string; body: ThemeFileBody }> };
      }>;
    };
  }>(
    admin,
    `#graphql
      query GooperAgentsTemplate($filenames: [String!]) {
        themes(first: 1, roles: [MAIN]) {
          nodes {
            id
            name
            files(filenames: $filenames, first: 1) {
              nodes {
                filename
                body {
                  __typename
                  ... on OnlineStoreThemeFileBodyText { content }
                  ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
                }
              }
            }
          }
        }
      }`,
    { filenames: [AGENTS_TEMPLATE] },
    "Shopify could not read your live theme.",
    AGENTS_THEME_SCOPE,
  );
  const theme = data.themes.nodes[0];
  if (!theme) throw new Error("Your store has no published theme.");
  const body = theme.files.nodes[0]?.body;
  const content =
    body && "content" in body
      ? body.content
      : body && "contentBase64" in body
        ? Buffer.from(body.contentBase64, "base64").toString("utf8")
        : null;
  return { themeId: theme.id, themeName: theme.name, content };
}

export async function agentsTemplateStatus(admin: AdminGraphql) {
  const { themeName, content } = await liveAgentsTemplate(admin);
  return { themeName, published: hasGooperSection(content), customTemplate: content !== null };
}

export function gooperAgentsSection(shop: string, guidance: ReturnGuidance) {
  return merchantAgentsTemplateSection(guidance, undefined, {
    appUrl: appOrigin(),
    store: shop,
  });
}

async function writeTemplate(admin: AdminGraphql, themeId: string, value: string) {
  const data = await adminRequest<{
    themeFilesUpsert: {
      upsertedThemeFiles: Array<{ filename: string }> | null;
      userErrors: Array<{ message: string }>;
    };
  }>(
    admin,
    `#graphql
      mutation GooperAgentsTemplateWrite($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
        themeFilesUpsert(themeId: $themeId, files: $files) {
          upsertedThemeFiles { filename }
          userErrors { field message code }
        }
      }`,
    {
      themeId,
      files: [{ filename: AGENTS_TEMPLATE, body: { type: "TEXT", value } }],
    },
    "Shopify did not save your agents.md.",
    AGENTS_THEME_SCOPE,
  );
  const errors = data.themeFilesUpsert.userErrors;
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
}

async function deleteTemplate(admin: AdminGraphql, themeId: string) {
  const data = await adminRequest<{
    themeFilesDelete: { userErrors: Array<{ message: string }> };
  }>(
    admin,
    `#graphql
      mutation GooperAgentsTemplateDelete($themeId: ID!, $files: [String!]!) {
        themeFilesDelete(themeId: $themeId, files: $files) {
          deletedThemeFiles { filename }
          userErrors { field message code }
        }
      }`,
    { themeId, files: [AGENTS_TEMPLATE] },
    "Shopify did not remove your agents.md.",
    AGENTS_THEME_SCOPE,
  );
  const errors = data.themeFilesDelete.userErrors;
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
}

// Adds or refreshes Gooper.io's section in the live theme's agents.md.
export async function publishAgentsSection(
  admin: AdminGraphql,
  shop: string,
  guidance: ReturnGuidance,
) {
  const { themeId, themeName, content } = await liveAgentsTemplate(admin);
  const next = templateWithGooperSection(content, gooperAgentsSection(shop, guidance));
  if (next !== content) await writeTemplate(admin, themeId, next);
  return { themeName };
}

// Keeps a published section current after the merchant changes their return
// guidance. Does nothing for a store that never published one.
export async function refreshAgentsSection(
  admin: AdminGraphql,
  shop: string,
  guidance: ReturnGuidance,
) {
  const { themeId, content } = await liveAgentsTemplate(admin);
  if (!hasGooperSection(content)) return false;
  const next = templateWithGooperSection(content, gooperAgentsSection(shop, guidance));
  if (next !== content) await writeTemplate(admin, themeId, next);
  return true;
}

export async function removeAgentsSection(admin: AdminGraphql) {
  const { themeId, content } = await liveAgentsTemplate(admin);
  if (!content || !hasGooperSection(content)) return;
  const next = templateWithoutGooperSection(content);
  // A template that was only Gooper.io's starter goes back to Shopify's default.
  const onlyStarter =
    next !== null && next.trim() === templateWithoutGooperSection(
      templateWithGooperSection(null, ""),
    )?.trim();
  if (next === null || onlyStarter) await deleteTemplate(admin, themeId);
  else await writeTemplate(admin, themeId, next);
}

async function refundPolicyBody(admin: AdminGraphql) {
  const data = await adminRequest<{
    shop: { shopPolicies: Array<{ type: string; body: string; url: string }> };
  }>(
    admin,
    `#graphql
      query GooperRefundPolicy {
        shop { shopPolicies { type body url } }
      }`,
    {},
    "Shopify could not read your refund policy.",
    REFUND_POLICY_SCOPE,
  );
  return data.shop.shopPolicies.find((policy) => policy.type === "REFUND_POLICY") ?? null;
}

export async function refundPolicyStatus(admin: AdminGraphql) {
  const policy = await refundPolicyBody(admin);
  return {
    exists: Boolean(policy?.body.trim()),
    published: hasGooperParagraph(policy?.body),
    url: policy?.url ?? null,
  };
}

async function writeRefundPolicy(admin: AdminGraphql, body: string) {
  const data = await adminRequest<{
    shopPolicyUpdate: { userErrors: Array<{ message: string }> };
  }>(
    admin,
    `#graphql
      mutation GooperRefundPolicyWrite($shopPolicy: ShopPolicyInput!) {
        shopPolicyUpdate(shopPolicy: $shopPolicy) {
          shopPolicy { id }
          userErrors { field message }
        }
      }`,
    { shopPolicy: { type: "REFUND_POLICY", body } },
    "Shopify did not save your refund policy.",
    REFUND_POLICY_SCOPE,
  );
  const errors = data.shopPolicyUpdate.userErrors;
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
}

// Adds Gooper.io's paragraph to the top of the store's own refund policy.
// A store without a refund policy is asked to write one first: Gooper.io
// doesn't create legal text on the merchant's behalf.
export async function publishRefundPolicyParagraph(admin: AdminGraphql, shop: string) {
  const policy = await refundPolicyBody(admin);
  if (!policy?.body.trim())
    throw new Error(
      "Your store has no refund policy yet. Add one in Shopify under Settings > Policies, then try again.",
    );
  const next = policyWithGooperParagraph(policy.body, refundPolicyParagraph(shop));
  if (next !== policy.body) await writeRefundPolicy(admin, next);
}

export async function removeRefundPolicyParagraph(admin: AdminGraphql) {
  const policy = await refundPolicyBody(admin);
  if (!policy || !hasGooperParagraph(policy.body)) return;
  await writeRefundPolicy(admin, policyWithoutGooperParagraph(policy.body));
}

export type DiscoveryStatus = {
  agents: { permission: boolean; published: boolean; themeName: string | null; error: string | null };
  policy: { permission: boolean; published: boolean; exists: boolean; error: string | null };
};

const statusError = (error: unknown) =>
  error instanceof Error ? error.message : "Shopify didn't answer.";

// What the dashboard shows for each button. A read that fails is shown as a
// message rather than failing the whole dashboard.
export async function discoveryStatus(admin: AdminGraphql): Promise<DiscoveryStatus> {
  let scopes = new Set<string>();
  try {
    scopes = await grantedScopes(admin);
  } catch {
    /* Treated as not yet granted; the button asks again. */
  }
  const agents: DiscoveryStatus["agents"] = {
    permission: scopes.has(AGENTS_THEME_SCOPE),
    published: false,
    themeName: null,
    error: null,
  };
  const policy: DiscoveryStatus["policy"] = {
    permission: scopes.has(REFUND_POLICY_SCOPE),
    published: false,
    exists: false,
    error: null,
  };
  await Promise.all([
    agents.permission &&
      agentsTemplateStatus(admin).then(
        (status) => {
          agents.published = status.published;
          agents.themeName = status.themeName;
        },
        (error) => {
          agents.error = statusError(error);
        },
      ),
    policy.permission &&
      refundPolicyStatus(admin).then(
        (status) => {
          policy.published = status.published;
          policy.exists = status.exists;
        },
        (error) => {
          policy.error = statusError(error);
        },
      ),
  ]);
  return { agents, policy };
}
