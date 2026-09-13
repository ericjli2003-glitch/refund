import {
  authenticateMerchantProxy,
  merchantAgentsMarkdown,
  merchantHandoffPage,
  merchantReturnDiscovery,
  proxyIntakeSchema,
  proxySchema,
} from "./merchant-proxy.server";
import { privateHeaders } from "./customer-security.server";
import { startReturnIntake } from "./return-intake.server";
import { readIntakeBody } from "./public-intake-http.server";
import { handleIntakeMcp } from "./intake-mcp-http.server";
import { publicReturnGuidance } from "./return-guidance.server";

export async function handleMerchantProxy(request: Request, path: string) {
  try {
    const { shop, pathPrefix } = await authenticateMerchantProxy(request);
    const route = path.replace(/\/+$/, "");
    if (route === "mcp") return await handleIntakeMcp(request, shop);
    if (route === "start-return" && request.method === "POST") {
      const parsed = proxyIntakeSchema.safeParse(await readIntakeBody(request));
      if (!parsed.success)
        return Response.json(
          {
            error:
              "Only optional orderName, itemName and UUID idempotencyKey are accepted. The merchant is fixed by Shopify.",
          },
          { status: 400, headers: privateHeaders },
        );
      return Response.json(
        await startReturnIntake({ ...parsed.data, merchant: shop }),
        { headers: privateHeaders },
      );
    }
    const known = [
      "",
      "start-return",
      "agents.md",
      "manifest.json",
      "ucp",
      "schema.json",
    ];
    if (!known.includes(route))
      return new Response("Not found.", {
        status: 404,
        headers: privateHeaders,
      });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed.", {
        status: 405,
        headers: {
          ...privateHeaders,
          Allow: route === "start-return" ? "GET, HEAD, POST" : "GET, HEAD",
        },
      });
    if (route === "agents.md")
      return new Response(
        merchantAgentsMarkdown(shop, pathPrefix, await publicReturnGuidance(shop)),
        {
          headers: {
            ...privateHeaders,
            "Content-Type": "text/markdown; charset=utf-8",
          },
        },
      );
    if (route === "manifest.json" || route === "ucp")
      return Response.json(
        merchantReturnDiscovery(shop, pathPrefix, await publicReturnGuidance(shop)),
        { headers: privateHeaders },
      );
    if (route === "schema.json")
      return Response.json(proxySchema(), { headers: privateHeaders });
    return merchantHandoffPage(shop, pathPrefix);
  } catch (error) {
    // No error body from the SDK, Shopify or storage is published to a crawler.
    const status = error instanceof Response ? error.status : 503;
    return Response.json(
      {
        error:
          status === 503
            ? "Return discovery is temporarily unavailable."
            : "Invalid or unavailable merchant proxy.",
      },
      { status, headers: privateHeaders },
    );
  }
}
