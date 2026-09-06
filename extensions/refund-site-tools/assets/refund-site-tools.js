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
  if (!modelContext?.registerTool || window.__refundSiteToolsRegistered) return;

  window.__refundSiteToolsRegistered = true;
  const root = roots[0];
  const store = readStore(root);

  const tools = [
    {
      name: "get_store_return_options",
      description:
        `Check how to start a return or refund for an item bought from ${store.name}. ` +
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
        storeName: store.name,
        storeDomain: store.domain,
        returnsSupported: true,
        customerAuthenticated: store.customerAuthenticated,
        accountUrl: store.accountUrl,
        portalUrl: store.portalUrl,
        portalAuthenticationRequired: true,
        nextStep: "Use start_store_return, then follow the visible link to the Refund customer portal. Storefront login alone does not authorize Refund to access purchases.",
      }),
    },
    {
      name: "start_store_return",
      description:
        `Open ${store.name}'s on-site return assistant for the customer. ` +
        "This starts the flow but does not create a return or issue a refund.",
      inputSchema: {
        type: "object",
        properties: {
          orderName: {
            type: "string",
            description: "Optional order number or name mentioned by the customer.",
          },
          itemName: {
            type: "string",
            description: "Optional product or item mentioned by the customer.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      execute: async (request = {}) => {
        openReturnPanel(root, request);
        return {
          status: "return_flow_opened",
          storeName: store.name,
          customerAuthenticated: store.customerAuthenticated,
          accountUrl: store.accountUrl,
          portalUrl: root.querySelector(".refund-site-tools__account-link")?.href,
          nextStep: "Click the visible return link to continue in the Refund customer portal. After customer sign-in, use its find_returnable_items and quote_return tools. Never submit until the customer explicitly confirms the quoted amount.",
          confirmationRequired: true,
        };
      },
    },
  ];

  for (const tool of tools) {
    Promise.resolve(modelContext.registerTool(tool)).catch(() => {
      window.__refundSiteToolsRegistered = false;
    });
  }
})();
