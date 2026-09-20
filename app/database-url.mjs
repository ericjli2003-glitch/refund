// Render hands out a connection string with no TLS parameters, and libpq will
// silently fall back to an unencrypted connection when the server allows it.
// Protected customer data has to be encrypted in transit, so every process that
// opens Postgres normalizes its URL through here first: the server, the
// migration step, and the funded-payments worker.
//
// Verify a deployed connection is actually encrypted with:
//   SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();

function isLoopback(hostname) {
  // A bracketed IPv6 host arrives from URL.hostname as "[::1]".
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Returns the connection string with `sslmode=require` applied.
 *
 * An explicit `sslmode` is always left alone, so a deployment that terminates
 * TLS in a sidecar can still opt out on purpose. Loopback addresses are left
 * alone too, because a local development database has no certificate.
 *
 * @param {string | undefined} url
 * @returns {string | undefined}
 */
export function databaseUrlWithTls(url) {
  if (!url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Prisma reports a malformed connection string far better than we can, and
    // an unparseable URL never opens a connection to leave unencrypted.
    return url;
  }
  if (parsed.searchParams.has("sslmode")) return url;
  if (isLoopback(parsed.hostname)) return url;
  parsed.searchParams.set("sslmode", "require");
  return parsed.toString();
}

/**
 * Applies the normalization to the environment so child processes inherit it.
 *
 * @param {NodeJS.ProcessEnv} environment
 */
export function requireDatabaseTls(environment = process.env) {
  const normalized = databaseUrlWithTls(environment.DATABASE_URL);
  if (normalized) environment.DATABASE_URL = normalized;
  return normalized;
}
