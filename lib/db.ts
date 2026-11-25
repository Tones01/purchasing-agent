import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

const QUERY_TIMEOUT_MS = 20_000;

// One short-lived connection per tool call, closed when the call finishes.
// Serverless functions are frozen between requests; a connection kept open across
// a freeze is often dead on the next request and hangs until the platform timeout.
// Opening fresh each time costs ~100ms and never hangs.
export async function withDb<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const sql = postgres(url, {
    prepare: false, // the Supabase transaction pooler does not support prepared statements
    max: 1,
    idle_timeout: 5,
    connect_timeout: 8,
    ssl: "require",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Database query timed out after ${QUERY_TIMEOUT_MS / 1000}s`)), QUERY_TIMEOUT_MS);
  });

  try {
    return await Promise.race([fn(sql), timeout]);
  } finally {
    clearTimeout(timer);
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}
