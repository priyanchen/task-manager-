import { createHash } from "node:crypto";

export function createAnalytics({ key, host = "https://us.i.posthog.com", send = fetch }) {
  if (!key) return () => {};

  return function track(userId, event, properties = {}) {
    const distinctId = createHash("sha256").update(`user:${userId}`).digest("hex").slice(0, 16);
    send(`${host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, event, distinct_id: distinctId, properties }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  };
}
