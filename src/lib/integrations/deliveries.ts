import {
  getDb,
  queryMany,
  queryOne,
  type DbExecutor,
} from "../db/connection.ts";
import { createDownloadResponse } from "../download-response.ts";
import {
  getSenderEnvelopeDownload,
  sanitizeFileNameSegment,
} from "../downloads.ts";
import { isMissingSchemaError } from "../settings.ts";
import { getEnv } from "../utils/env.ts";
import {
  accessTokenForConnection,
  createFolder,
  getDriveConnection,
  uploadPdf,
} from "./google-drive.ts";
import { signWebhookBody } from "./webhook-signing.ts";
import { checkWebhookTarget } from "./webhook-url.ts";
import { readEndpointSecret } from "./webhooks.ts";
import { retryDelaySeconds } from "./queue.ts";

// Works through the delivery queue (queue.ts) for webhooks and Google Drive
// uploads. Once an event's transaction commits, kickDeliveries works through
// whatever is due, after the response has gone out. A failed attempt is
// tried again after RETRY_DELAYS_SECONDS; while the app keeps running a
// timer picks up retries due soon, and the daily job (retention-job.ts)
// sweeps up anything left, for example after the container went to sleep.

// Long enough for a slow upload; a worker that dies mid-attempt lets the row
// come due again after this.
const LEASE_SECONDS = 5 * 60;
const BATCH_SIZE = 20;
const MAX_BATCHES = 10;
const WEBHOOK_TIMEOUT_MS = 15_000;
const HISTORY_DAYS = 30;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export type WebhookPayload = {
  /** The delivery's id: the same on every retry, for receivers to dedupe. */
  id: string;
  type: string;
  createdAt: string;
  data: {
    envelope?: {
      id: string;
      status: string;
      title: string;
      url: string | null;
    };
    signer?: { email: string; id: string; name: string; order: number | null };
    /** Completed envelopes only. Both need a signed-in sender. */
    documents?: { certificateUrl: string; signedPdfUrl: string };
    message?: string;
  };
};

export function buildWebhookPayload(input: {
  appUrl: string | null;
  deliveryId: string;
  envelope: { id: string; status: string; title: string } | null;
  event: string;
  metadata: Record<string, unknown> | null;
  occurredAt: number;
}): WebhookPayload {
  const createdAt = new Date(input.occurredAt * 1000).toISOString();

  if (input.event === "test" || !input.envelope) {
    return {
      createdAt,
      data: { message: "A test delivery from SignuDoc." },
      id: input.deliveryId,
      type: "test",
    };
  }

  const { envelope, metadata } = input;
  const appLink = (path: string) =>
    input.appUrl ? new URL(path, input.appUrl).toString() : null;
  const payload: WebhookPayload = {
    createdAt,
    data: {
      envelope: {
        id: envelope.id,
        status: envelope.status,
        title: envelope.title,
        url: appLink(`/envelopes/${envelope.id}`),
      },
    },
    id: input.deliveryId,
    type: `envelope.${input.event}`,
  };

  if (
    ["viewed", "signed", "declined"].includes(input.event) &&
    typeof metadata?.signerId === "string"
  ) {
    payload.data.signer = {
      email: String(metadata.signerEmail ?? ""),
      id: metadata.signerId,
      name: String(metadata.signerName ?? ""),
      order:
        typeof metadata.signerOrder === "number" ? metadata.signerOrder : null,
    };
  }

  if (input.event === "completed" && input.appUrl) {
    const download = `/api/envelopes/${envelope.id}/download?type=`;

    payload.data.documents = {
      certificateUrl: appLink(`${download}evidence`) ?? "",
      signedPdfUrl: appLink(`${download}signed`) ?? "",
    };
  }

  return payload;
}

type DeliveryRow = {
  attempts: number;
  auditEventId: string | null;
  createdAt: number;
  endpointId: string | null;
  envelopeId: string | null;
  event: string;
  id: string;
  target: "drive" | "webhook";
};

/** permanent: no point trying again (the envelope is gone, say). */
type AttemptResult =
  | { ok: true; statusCode?: number }
  | { error: string; ok: false; permanent?: boolean; statusCode?: number };

async function attemptWebhook(
  delivery: DeliveryRow,
  database: DbExecutor,
): Promise<AttemptResult> {
  const endpoint = await queryOne<{ secretEncrypted: string; url: string }>(
    database,
    `SELECT url, secret_encrypted AS "secretEncrypted" FROM webhook_endpoints WHERE id = $1`,
    [delivery.endpointId],
  );

  if (!endpoint) {
    return { error: "The endpoint was removed.", ok: false, permanent: true };
  }

  const secret = readEndpointSecret(endpoint.secretEncrypted);

  if (!secret) {
    return {
      error:
        "The signing secret cannot be read (the auth secret changed). Add the endpoint again.",
      ok: false,
      permanent: true,
    };
  }

  const blocked = await checkWebhookTarget(endpoint.url);

  if (blocked) {
    return { error: blocked, ok: false, permanent: true };
  }

  let envelope: { id: string; status: string; title: string } | null = null;
  let audit: {
    createdAt: number;
    metadata: Record<string, unknown> | null;
  } | null = null;

  if (delivery.event !== "test") {
    [envelope, audit] = await Promise.all([
      queryOne<{ id: string; status: string; title: string }>(
        database,
        "SELECT id, status, title FROM envelopes WHERE id = $1",
        [delivery.envelopeId],
      ),
      queryOne<{ createdAt: number; metadata: Record<string, unknown> | null }>(
        database,
        `SELECT created_at AS "createdAt", metadata FROM audit_events WHERE id = $1`,
        [delivery.auditEventId],
      ),
    ]);

    if (!envelope) {
      return {
        error: "The envelope no longer exists.",
        ok: false,
        permanent: true,
      };
    }
  }

  const body = JSON.stringify(
    buildWebhookPayload({
      appUrl: getEnv().appUrl ?? null,
      deliveryId: delivery.id,
      envelope,
      event: delivery.event,
      metadata: audit?.metadata ?? null,
      occurredAt: audit?.createdAt ?? delivery.createdAt,
    }),
  );

  try {
    const response = await fetch(endpoint.url, {
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": "SignuDoc-Webhooks/1",
        "x-signature": signWebhookBody(secret, body),
        "x-signudoc-delivery": delivery.id,
        "x-signudoc-event": delivery.event,
      },
      method: "POST",
      // A redirect could point anywhere, including inside the network.
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });

    await response.body?.cancel().catch(() => undefined);

    return response.status >= 200 && response.status < 300
      ? { ok: true, statusCode: response.status }
      : {
          error: `The endpoint answered ${String(response.status)}.`,
          ok: false,
          statusCode: response.status,
        };
  } catch (error) {
    // Only the kind of failure: the message could repeat the URL, which may
    // carry a token of the receiver's.
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "timed out"
        : ((error as { cause?: { code?: string } }).cause?.code ??
          "could not connect");

    return { error: `The request failed: ${reason}.`, ok: false };
  }
}

async function readEnvelopeFile(
  userId: string,
  envelopeId: string,
  type: "evidence" | "signed",
  database: DbExecutor,
) {
  const download = await getSenderEnvelopeDownload(userId, envelopeId, type, {
    database,
  });
  const response = await createDownloadResponse(download);

  return {
    body: new Uint8Array(await response.arrayBuffer()),
    name: download.fileName,
  };
}

async function attemptDriveUpload(
  delivery: DeliveryRow,
  database: DbExecutor,
): Promise<AttemptResult> {
  const connection = await getDriveConnection(database);

  if (!connection) {
    return {
      error: "Google Drive is not connected.",
      ok: false,
      permanent: true,
    };
  }

  const envelope = await queryOne<{
    id: string;
    title: string;
    userId: string;
  }>(
    database,
    `SELECT id, title, user_id AS "userId" FROM envelopes WHERE id = $1`,
    [delivery.envelopeId],
  );

  if (!envelope) {
    return {
      error: "The envelope no longer exists.",
      ok: false,
      permanent: true,
    };
  }

  try {
    const accessToken = await accessTokenForConnection(connection);
    const files = [
      await readEnvelopeFile(envelope.userId, envelope.id, "signed", database),
      await readEnvelopeFile(
        envelope.userId,
        envelope.id,
        "evidence",
        database,
      ),
    ];
    // shortcut: a retry after one of the two files went up uploads both
    // again (and makes another subfolder); fine while failures are rare.
    const parentId = connection.subfolderPerEnvelope
      ? (
          await createFolder(
            accessToken,
            `${sanitizeFileNameSegment(envelope.title) || "Envelope"} (${envelope.id.slice(0, 8)})`,
            connection.folderId,
          )
        ).id
      : connection.folderId;

    for (const file of files) {
      await uploadPdf(accessToken, { ...file, parentId });
    }

    await database.query(
      `UPDATE google_drive_connection SET last_upload_at = $1, last_upload_error = NULL WHERE id = 1`,
      [nowSeconds()],
    );

    return { ok: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 300) : "Upload failed.";

    await database.query(
      `UPDATE google_drive_connection SET last_upload_error = $1 WHERE id = 1`,
      [message],
    );

    return { error: message, ok: false };
  }
}

async function finishAttempt(
  delivery: DeliveryRow,
  result: AttemptResult,
  database: DbExecutor,
): Promise<void> {
  const attempts = delivery.attempts + 1;
  const now = nowSeconds();
  const delay =
    result.ok || result.permanent ? null : retryDelaySeconds(attempts);
  const status = result.ok
    ? "delivered"
    : delay === null
      ? "failed"
      : "pending";

  await database.query(
    `
      UPDATE integration_deliveries SET
        status = $2,
        attempts = $3,
        last_attempt_at = $4,
        next_attempt_at = $5,
        last_status_code = $6,
        last_error = $7
      WHERE id = $1
    `,
    [
      delivery.id,
      status,
      attempts,
      now,
      now + (delay ?? 0),
      result.statusCode ?? null,
      result.ok ? null : result.error,
    ],
  );
}

/** Claims due deliveries in batches and tries each once. */
export async function processDueDeliveries(
  database: DbExecutor = getDb(),
): Promise<{ attempted: number; delivered: number }> {
  let attempted = 0;
  let delivered = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const now = nowSeconds();
    // Pushing next_attempt_at out is the lease: another worker skips these.
    const due = await queryMany<DeliveryRow>(
      database,
      `
        UPDATE integration_deliveries SET next_attempt_at = $1 + $2
        WHERE id IN (
          SELECT id FROM integration_deliveries
          WHERE status = 'pending' AND next_attempt_at <= $1
          ORDER BY next_attempt_at
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        )
        RETURNING
          id, target, endpoint_id AS "endpointId", event,
          envelope_id AS "envelopeId", audit_event_id AS "auditEventId",
          attempts, created_at AS "createdAt"
      `,
      [now, LEASE_SECONDS, BATCH_SIZE],
    );

    for (const delivery of due) {
      const result = await (
        delivery.target === "drive" ? attemptDriveUpload : attemptWebhook
      )(delivery, database).catch((error: unknown): AttemptResult => ({
        error: error instanceof Error ? error.message.slice(0, 300) : "Failed.",
        ok: false,
      }));

      await finishAttempt(delivery, result, database);
      attempted += 1;
      delivered += result.ok ? 1 : 0;
    }

    if (due.length < BATCH_SIZE) {
      break;
    }
  }

  return { attempted, delivered };
}

/** Clears finished deliveries older than the history the settings page shows. */
export async function pruneDeliveries(
  database: DbExecutor = getDb(),
): Promise<void> {
  await database.query(
    `DELETE FROM integration_deliveries WHERE status <> 'pending' AND created_at < $1`,
    [nowSeconds() - HISTORY_DAYS * 24 * 60 * 60],
  );
}

let running = false;
let rerun = false;
let timer: ReturnType<typeof setTimeout> | null = null;
// Retries due within this long are picked up by a timer while the app runs.
const TIMER_HORIZON_SECONDS = 15 * 60;

async function runQueue(): Promise<void> {
  do {
    rerun = false;
    await processDueDeliveries();
  } while (rerun);

  const next = await queryOne<{ dueAt: number | null }>(
    getDb(),
    `SELECT min(next_attempt_at) AS "dueAt" FROM integration_deliveries WHERE status = 'pending'`,
  );
  const dueIn = next?.dueAt == null ? null : Number(next.dueAt) - nowSeconds();

  if (dueIn !== null && dueIn <= TIMER_HORIZON_SECONDS) {
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(
      () => {
        timer = null;
        kickDeliveries();
      },
      Math.max(dueIn, 1) * 1000,
    );
    timer.unref?.();
  }
}

/** Works through due deliveries in the background. Safe to call often. */
export function kickDeliveries(): void {
  if (running) {
    rerun = true;
    return;
  }

  running = true;

  const task = () =>
    runQueue()
      .catch((error: unknown) => {
        if (!isMissingSchemaError(error)) {
          console.error(
            "[deliveries] Processing the delivery queue failed:",
            error instanceof Error ? error.message : "unknown error",
          );
        }
      })
      .finally(() => {
        running = false;
      });

  // after() keeps a serverless function alive until the work is done. It is
  // loaded lazily so plain Node (the tests, scripts) can import this file;
  // there, and outside a request, the work just starts.
  import("next/server")
    .then(({ after }) => after(task))
    .catch(() => void task());
}
