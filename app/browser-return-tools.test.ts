import assert from "node:assert/strict";
import test from "node:test";
import {
  registerBrowserReturnTools,
  returnSessionTool,
  type BrowserModelContext,
  type BrowserTool,
} from "./browser-return-tools";

const session = {
  shop: "testing.myshopify.com",
  authenticated: false,
  loginUrl: "https://refund.test/customer/login?shop=testing.myshopify.com",
};
const tool = returnSessionTool(session);
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("browser handoff requires verification, not connector installation", async () => {
  const pending = (await tool.execute({})) as Record<string, unknown>;
  assert.equal(pending.connectorRequired, false);
  assert.equal(pending.authenticationRequired, true);
  assert.equal(pending.nextTool, null);
  assert.equal(pending.loginUrl, session.loginUrl);
  assert.equal(pending.refundSubmitted, false);
  const verified = (await returnSessionTool({
    ...session,
    authenticated: true,
  }).execute({})) as Record<string, unknown>;
  assert.equal(verified.nextTool, "find_returnable_items");
  assert.equal(verified.confirmationRequired, true);
  assert.equal(verified.returnSubmitted, false);
  assert.equal(verified.loginUrl, undefined);
});

test("unsupported browsers report unavailable without registering anything", () => {
  const states: string[] = [];
  registerBrowserReturnTools(undefined, [tool], (state) =>
    states.push(state),
  )();
  assert.deepEqual(states, ["unavailable"]);
});

test("the session tool resumes authenticated drafts but never invokes recovery before sign-in", async () => {
  let calls = 0;
  const resume = async () => {
    calls++;
    return { status: "quoted", quoteValid: true };
  };
  await returnSessionTool({ ...session, resume }).execute({});
  assert.equal(calls, 0);
  assert.deepEqual(
    await returnSessionTool({
      ...session,
      authenticated: true,
      resume,
    }).execute({}),
    { status: "quoted", quoteValid: true },
  );
  assert.equal(calls, 1);
});

test("modern registrations are removed by their own AbortSignal and can remount", async () => {
  const active = new Map<string, BrowserTool>();
  active.set("merchant_unrelated_tool", tool);
  const context: BrowserModelContext = {
    registerTool(value, { signal }) {
      assert.equal(active.has(value.name), false);
      active.set(value.name, value);
      signal.addEventListener("abort", () => active.delete(value.name), {
        once: true,
      });
      return Promise.resolve();
    },
  };
  const states: string[] = [];
  const stop = registerBrowserReturnTools(context, [tool], (state) =>
    states.push(state),
  );
  await settle();
  assert.deepEqual(states, ["ready"]);
  stop();
  assert.equal(active.has(tool.name), false);
  assert.equal(active.has("merchant_unrelated_tool"), true);
  const next = registerBrowserReturnTools(context, [tool], () => {});
  await settle();
  assert.equal(active.has(tool.name), true);
  next();
});

test("rejected registration cleans up the partial batch and reports failure", async () => {
  let signal: AbortSignal | undefined;
  const states: string[] = [];
  const stop = registerBrowserReturnTools(
    {
      registerTool(value, options) {
        signal = options.signal;
        if (value.name === "broken")
          return Promise.reject(new Error("unsupported"));
      },
    },
    [tool, { ...tool, name: "broken" }],
    (state) => states.push(state),
  );
  await settle();
  assert.equal(signal?.aborted, true);
  assert.deepEqual(states, ["failed"]);
  stop();
});

test("unmount during registration cannot publish stale readiness or register more tools", async () => {
  let complete!: () => void;
  let calls = 0;
  const states: string[] = [];
  const stop = registerBrowserReturnTools(
    {
      registerTool() {
        calls++;
        return new Promise<void>((resolve) => {
          complete = resolve;
        });
      },
    },
    [tool, { ...tool, name: "later" }],
    (state) => states.push(state),
  );
  stop();
  complete();
  await settle();
  assert.equal(calls, 1);
  assert.deepEqual(states, []);
});
