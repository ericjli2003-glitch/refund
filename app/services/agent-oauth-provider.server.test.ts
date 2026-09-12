import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidClientMetadataError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import prisma from "../db.server";
import { createAgentOAuthProvider } from "./agent-oauth-provider.server";

const valid = {
  redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  scope: "returns:read returns:quote returns:submit",
};

test("ChatGPT registration accepts authorization code plus rotating refresh tokens", async (t) => {
  process.env.SHOPIFY_API_SECRET ||= "test-secret";
  const originalCount = prisma.agentOAuthClient.count;
  const originalCreate = prisma.agentOAuthClient.create;
  const create = t.mock.fn(async () => ({}));
  Reflect.set(prisma.agentOAuthClient, "count", async () => 0);
  Reflect.set(prisma.agentOAuthClient, "create", create);
  t.after(() => {
    Reflect.set(prisma.agentOAuthClient, "count", originalCount);
    Reflect.set(prisma.agentOAuthClient, "create", originalCreate);
  });
  const client =
    await createAgentOAuthProvider().clientsStore.registerClient!(valid);
  assert.equal(client.client_name, "ChatGPT");
  assert.deepEqual(client.grant_types, ["authorization_code", "refresh_token"]);
  assert.deepEqual(client.response_types, ["code"]);
  assert.equal(client.token_endpoint_auth_method, "none");
  assert.equal(client.client_secret, undefined);
  assert.equal(create.mock.callCount(), 1);
});

test("registration errors identify rejected fields without echoing supplied metadata", async (t) => {
  const original = prisma.agentOAuthClient.count;
  const count = t.mock.fn(async () => {
    throw new Error("Metadata rejection must not query storage");
  });
  Reflect.set(prisma.agentOAuthClient, "count", count);
  t.after(() => Reflect.set(prisma.agentOAuthClient, "count", original));
  const cases = [
    [{ redirect_uris: [] }, "registration_redirect_count"],
    [
      { redirect_uris: ["https://evil.test/private-secret"] },
      "registration_callback",
    ],
    [
      {
        redirect_uris: [
          ...valid.redirect_uris,
          "https://claude.ai/api/mcp/auth_callback",
        ],
      },
      "registration_mixed_hosts",
    ],
    [
      { token_endpoint_auth_method: "client_secret_basic" },
      "registration_auth_method",
    ],
    [
      { grant_types: ["authorization_code", "client_credentials"] },
      "registration_grant_type",
    ],
    [{ response_types: ["token"] }, "registration_response_type"],
    [{ scope: "returns:read private-secret" }, "registration_scopes"],
    [{ scope: "returns:read returns:read" }, "registration_scopes"],
  ] as const;
  const store = createAgentOAuthProvider().clientsStore;
  for (const [override, reason] of cases) {
    await assert.rejects(
      async () =>
        store.registerClient!({ ...valid, ...override } as typeof valid),
      (error: unknown) => {
        assert.ok(error instanceof InvalidClientMetadataError);
        assert.ok(error.message.includes(`[${reason}]`));
        assert.ok(!error.message.includes("private-secret"));
        assert.ok(!error.message.includes("evil.test"));
        return true;
      },
    );
  }
  assert.equal(count.mock.callCount(), 0);
});

test("registration storage and capacity failures are server errors, not callback errors", async (t) => {
  process.env.SHOPIFY_API_SECRET ||= "test-secret";
  const originalCount = prisma.agentOAuthClient.count;
  const originalCreate = prisma.agentOAuthClient.create;
  t.after(() => {
    Reflect.set(prisma.agentOAuthClient, "count", originalCount);
    Reflect.set(prisma.agentOAuthClient, "create", originalCreate);
  });
  const store = createAgentOAuthProvider().clientsStore;
  for (const stage of ["count", "create", "capacity"]) {
    Reflect.set(prisma.agentOAuthClient, "count", async () => {
      if (stage === "count") throw new Error("database-private-secret");
      return stage === "capacity" ? 5000 : 0;
    });
    Reflect.set(prisma.agentOAuthClient, "create", async () => {
      throw new Error("database-private-secret");
    });
    await assert.rejects(
      async () => store.registerClient!(valid),
      (error: unknown) => {
        assert.ok(error instanceof ServerError);
        assert.ok(
          error.message.includes(
            stage === "capacity"
              ? "[registration_capacity]"
              : "[registration_storage]",
          ),
        );
        assert.ok(!error.message.includes("private-secret"));
        return true;
      },
    );
  }
});
