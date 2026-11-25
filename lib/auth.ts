import { timingSafeEqual } from "node:crypto";

// Clients send the shared key as "Authorization: Bearer <key>" or as "?key=<key>".
// The query form exists because some MCP clients only accept a URL.
export function isAuthorized(req: Request): boolean {
  const expected = process.env.MCP_API_KEY;
  if (!expected) return false;

  const header = req.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const fromQuery = new URL(req.url).searchParams.get("key") ?? "";
  const provided = bearer || fromQuery;
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
