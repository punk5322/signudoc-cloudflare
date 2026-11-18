import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Every webhook request carries
//
//   X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
//
// where the HMAC is over `${t}.${raw request body}` with the endpoint's
// secret (the whsec_... value shown once when the endpoint was added). To
// verify, a receiver recomputes the HMAC over the raw body exactly as it
// arrived, compares it in constant time, and rejects a timestamp older than
// a few minutes so a captured request cannot be replayed later.
// verifyWebhookSignature below is that check; docs/webhooks.md has it in a
// few lines for receivers that do not run this code.

export const SIGNATURE_HEADER = "X-Signature";
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function hmacHex(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret)
    .update(`${String(timestamp)}.${body}`)
    .digest("hex");
}

export function signWebhookBody(
  secret: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  return `t=${String(timestamp)},v1=${hmacHex(secret, timestamp, body)}`;
}

export function verifyWebhookSignature(
  secret: string,
  header: string | null,
  body: string,
  {
    now = Math.floor(Date.now() / 1000),
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  }: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  const parts = new Map(
    (header ?? "").split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=");

      return [key, rest.join("=")] as const;
    }),
  );
  const timestamp = Number(parts.get("t"));
  const signature = parts.get("v1") ?? "";

  if (
    !Number.isInteger(timestamp) ||
    Math.abs(now - timestamp) > toleranceSeconds ||
    !/^[0-9a-f]{64}$/.test(signature)
  ) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(hmacHex(secret, timestamp, body), "hex"),
  );
}
