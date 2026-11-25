import postgres from "postgres";

let client: ReturnType<typeof postgres> | null = null;

// One small, reused pool per server instance. The Supabase transaction pooler
// does not support prepared statements, so they are turned off.
export function db() {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    client = postgres(url, {
      prepare: false,
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: "require",
    });
  }
  return client;
}
