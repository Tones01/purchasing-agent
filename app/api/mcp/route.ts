import { createMcpHandler } from "mcp-handler";
import { registerTools } from "../../../lib/tools";
import { isAuthorized } from "../../../lib/auth";

const mcp = createMcpHandler((server) => registerTools(server), {
  serverInfo: { name: "purchasing-agent", version: "0.1.0" },
});

async function handler(req: Request) {
  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return mcp(req);
}

export const maxDuration = 30;
export { handler as GET, handler as POST, handler as DELETE };
