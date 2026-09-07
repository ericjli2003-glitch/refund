import { privateHeaders } from "./customer-security.server";

export const intakeHeaders = {
  ...privateHeaders,
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-protocol-version",
};

export async function readIntakeBody(request: Request, maxBytes = 16_384) {
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  )
    throw new Response("Use application/json.", { status: 415 });
  if (!request.body)
    throw new Response("A request body is required.", { status: 400 });
  const reader = request.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (length <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Response("Request too large.", { status: 413 });
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Invalid JSON request.", { status: 400 });
  } finally {
    reader.releaseLock();
  }
}

export function intakeResponse(response: Response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(intakeHeaders))
    headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}
