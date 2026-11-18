import { afterCommit, getDb, type DbExecutor } from "../db/connection.ts";

// The delivery queue for webhooks and Google Drive uploads.
//
// recordAuditEvent calls enqueueEnvelopeEvent inside the transaction that
// writes the audit row, so a delivery exists exactly when its event was
// committed, and one rolled back is never sent. deliveries.ts does the
// sending. Kept apart from it so the audit trail does not load the PDF and
// Google code.

export const WEBHOOK_EVENTS = [
  "sent",
  "viewed",
  "signed",
  "completed",
  "declined",
  "voided",
  "expired",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** The wait before each retry. One attempt plus one per entry, then failed. */
export const RETRY_DELAYS_SECONDS = [
  60,
  5 * 60,
  30 * 60,
  2 * 60 * 60,
  6 * 60 * 60,
  12 * 60 * 60,
  24 * 60 * 60,
];

/** Seconds until the next try after `attempts` failed ones, or null to give up. */
export function retryDelaySeconds(attempts: number): number | null {
  return RETRY_DELAYS_SECONDS[attempts - 1] ?? null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Queues the deliveries an envelope audit event calls for. Runs inside the
 * audit row's transaction.
 */
export async function enqueueEnvelopeEvent(
  input: {
    auditEventId: string;
    envelopeId: string;
    event: string;
  },
  database: DbExecutor,
): Promise<void> {
  if (!isWebhookEvent(input.event)) {
    return;
  }

  const result = await database.query(
    `
      INSERT INTO integration_deliveries (
        id, target, endpoint_id, event, envelope_id, audit_event_id,
        next_attempt_at, created_at
      )
      SELECT gen_random_uuid()::text, 'webhook', id, $1::text, $2::text,
        $3::text, $4::bigint, $4::bigint
      FROM webhook_endpoints
      WHERE $1::text = ANY(events)
      UNION ALL
      SELECT gen_random_uuid()::text, 'drive', NULL, $1::text, $2::text,
        $3::text, $4::bigint, $4::bigint
      FROM google_drive_connection
      WHERE $1::text = 'completed'
    `,
    [input.event, input.envelopeId, input.auditEventId, nowSeconds()],
  );

  if ((result.rowCount ?? 0) > 0) {
    afterCommit(database, () => {
      void import("./deliveries.ts").then(({ kickDeliveries }) =>
        kickDeliveries(),
      );
    });
  }
}

export async function enqueueTestDelivery(
  endpointId: string,
  database: DbExecutor = getDb(),
): Promise<void> {
  const now = nowSeconds();

  await database.query(
    `
      INSERT INTO integration_deliveries (
        id, target, endpoint_id, event, next_attempt_at, created_at
      ) VALUES (gen_random_uuid()::text, 'webhook', $1, 'test', $2, $2)
    `,
    [endpointId, now],
  );
}
