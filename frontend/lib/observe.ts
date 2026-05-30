// Minimal structured error reporting. Logs a JSON line that any log drain
// (Vercel Log Drains, Datadog, Sentry's Vercel integration) can ingest without
// a heavyweight SDK or a mandatory DSN. If SENTRY_DSN is set we also POST to
// Sentry's store endpoint best-effort; otherwise this is a no-op beyond the log.

type Severity = "error" | "warning" | "info";

export function reportEvent(
  scope: string,
  message: string,
  severity: Severity = "error",
  extra?: Record<string, unknown>,
): void {
  const event = {
    ts: new Date().toISOString(),
    scope,
    severity,
    message,
    ...extra,
  };
  // Structured single-line log — picked up by Vercel log drains.
  const line = JSON.stringify(event);
  if (severity === "error") console.error(line);
  else if (severity === "warning") console.warn(line);
  else console.log(line);

  // Optional Sentry passthrough (fire-and-forget, never blocks the request).
  const dsn = process.env.SENTRY_DSN;
  if (dsn && severity !== "info") {
    void forwardToSentry(dsn, event).catch(() => { /* swallow */ });
  }
}

async function forwardToSentry(dsn: string, event: Record<string, unknown>): Promise<void> {
  // Parse DSN: https://<key>@<host>/<projectId>
  const m = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(\d+)$/);
  if (!m) return;
  const [, key, host, projectId] = m;
  const url = `https://${host}/api/${projectId}/store/`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${key}`,
    },
    body: JSON.stringify({
      level: event.severity === "warning" ? "warning" : "error",
      logger: String(event.scope),
      message: String(event.message),
      extra: event,
      platform: "javascript",
    }),
  });
}
