// The one shape every Wix service talks to Wix through. `wixApiFor(shop)`
// (wix-client.server.ts) returns a real client for an installed site; tests
// pass a fake.
export type WixMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type WixRequestOptions = {
  // Sent as an idempotency header where the Wix endpoint supports one.
  idempotencyKey?: string;
};

// Calls https://www.wixapis.com + path as the app, for one installed site.
export type WixApi = <T>(
  method: WixMethod,
  path: string,
  body?: unknown,
  options?: WixRequestOptions,
) => Promise<T>;

export class WixApiError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
    // Wix answered without running the operation (4xx other than 409/429),
    // so nothing changed and trying again after fixing the cause is safe.
    public readonly rejected = false,
    // Wix's own error code, when it sent one.
    public readonly code?: string,
  ) {
    super(message);
    this.name = "WixApiError";
  }
}
