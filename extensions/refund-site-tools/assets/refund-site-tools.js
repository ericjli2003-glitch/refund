(() => {
  const roots = Array.from(
    document.querySelectorAll("[data-refund-site-tools]"),
  );

  if (roots.length === 0) return;

  function readStore(root) {
    return {
      domain: root.dataset.shopDomain || window.location.hostname,
      name: root.dataset.shopName || window.location.hostname,
      accountUrl: new URL(
        root.dataset.accountUrl || "/account",
        window.location.origin,
      ).toString(),
      customerAuthenticated:
        root.dataset.customerAuthenticated === "true",
      portalUrl: root.dataset.portalUrl,
      intakeApiUrl: root.dataset.intakeApiUrl,
      intakeMcpUrl: root.dataset.intakeMcpUrl,
    };
  }

  function openReturnPanel(root, request = {}) {
    const dialog = root.querySelector("[data-refund-dialog]");
    const launcher = root.querySelector("[data-refund-launcher]");
    const status = root.querySelector("[data-refund-status]");
    const requestedItem = request.itemName || request.orderName;
    const link = root.querySelector(".refund-site-tools__account-link");
    const url = new URL(root.dataset.portalUrl);
    for (const field of ["orderName", "itemName"]) {
      if (typeof request[field] === "string") url.searchParams.set(field, request[field].slice(0, 120));
    }
    if (link) link.href = url.toString();

    if (status && requestedItem) {
      const prefix = root.dataset.intentPrefix || "Return request for";
      status.textContent = `${prefix} ${requestedItem}`;
    }

    if (dialog && typeof dialog.showModal === "function" && !dialog.open) {
      dialog.showModal();
    }

    if (launcher) launcher.setAttribute("aria-expanded", "true");
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Gooper.io is unavailable.");
    return payload;
  }

  for (const root of roots) {
    const dialog = root.querySelector("[data-refund-dialog]");
    const launcher = root.querySelector("[data-refund-launcher]");
    const close = root.querySelector("[data-refund-close]");

    launcher?.addEventListener("click", () => openReturnPanel(root));
    close?.addEventListener("click", () => dialog?.close());
    dialog?.addEventListener("close", () => {
      launcher?.setAttribute("aria-expanded", "false");
    });
  }

  const modelContext = document.modelContext;
  if (window.top !== window || !modelContext?.registerTool || window.__refundSiteToolsRegistered) return;

  window.__refundSiteToolsRegistered = true;
  const root = roots[0];
  const store = readStore(root);

  const tools = [
    {
      name: "get_store_return_options",
      description:
        `Check how to start a return or refund for an item bought from ${store.name}, including the merchant's published return policy link and instructions. ` +
        "Use this when a customer asks about returning or refunding a purchase from this store.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
      execute: async () => ({
        ...(await fetch(
          `${new URL(store.intakeApiUrl).origin}/api/merchant-readiness?merchant=${encodeURIComponent(store.domain)}`,
          { signal: AbortSignal.timeout(15_000) },
        ).then(async (response) => ({
          readiness: await response.json(),
          readinessHttpStatus: response.status,
        })).catch(() => ({
          readiness: { status: "unavailable", recovery: "Retry start_return or contact the merchant." },
          readinessHttpStatus: 503,
        }))),
        storeName: store.name,
        storeDomain: store.domain,
        returnsSupported: true,
        customerAuthenticated: store.customerAuthenticated,
        portalAuthenticationRequired: true,
        nextStep: "Use start_return. The customer must complete Shopify verification before purchase lookup.",
      }),
    },
    {
      name: "start_return",
      description:
        `Start a secure return draft for a purchase from ${store.name}. ` +
        "Returns a Shopify verification URL and correlation ID. It does not read purchases, create a return, or issue a refund.",
      inputSchema: {
        type: "object",
        properties: {
          orderName: {
            type: "string",
            maxLength: 120,
            description: "Optional order number or name mentioned by the customer.",
          },
          itemName: {
            type: "string",
            maxLength: 120,
            description: "Optional product or item mentioned by the customer.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      execute: async (request = {}) => {
        try {
          // Retry the same intent with the same key, including after navigation.
          // Store no order/item text or customer credentials in browser storage.
          const intent = JSON.stringify([store.domain, request.orderName || "", request.itemName || ""]);
          const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(intent));
          const fingerprint = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
          const storageKey = `refund-intake:${fingerprint}`;
          let idempotencyKey = crypto.randomUUID();
          try {
            const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
            if (saved?.expiresAt > Date.now()) idempotencyKey = saved.key;
            sessionStorage.setItem(storageKey, JSON.stringify({ key: idempotencyKey, expiresAt: Date.now() + 25 * 60_000 }));
          } catch { /* Storage may be unavailable. Starting a new draft cannot submit money. */ }
          const result = await postJson(store.intakeApiUrl, {
            idempotencyKey,
            merchant: store.domain,
            orderName: request.orderName,
            itemName: request.itemName,
          });
          openReturnPanel(root, request);
          const link = root.querySelector(".refund-site-tools__account-link");
          if (link && result.continueUrl) link.href = result.continueUrl;
          return {
            ...result,
            storeName: store.name,
            customerAuthenticated: store.customerAuthenticated,
          };
        } catch (error) {
          return {
            isError: true,
            status: "temporarily_unavailable",
            message: error instanceof Error ? error.message : "Gooper.io is unavailable.",
            recovery: "Retry once. If it still fails, use the visible return link or contact the merchant.",
          };
        }
      },
    },
  ];

  (async () => {
    const controller = new AbortController();
    try {
      for (const tool of tools) {
        await modelContext.registerTool(tool, { signal: controller.signal });
      }
    } catch {
      controller.abort();
      window.__refundSiteToolsRegistered = false;
    }
  })();
})();
