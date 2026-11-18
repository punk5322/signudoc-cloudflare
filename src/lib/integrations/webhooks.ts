import { randomUUID } from "node:crypto";

import {
  getDb,
  queryMany,
  queryOne,
  type DbExecutor,
} from "../db/connection.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "../services/seal-identity.ts";
import type { WebhookEvent } from "./queue.ts";
import { generateWebhookSecret } from "./webhook-signing.ts";

// The webhook endpoints an administrator added in Settings. The signing
// secret is returned once, by createWebhookEndpoint, and otherwise kept
// encrypted (the same scheme as the seal key in seal-identity.ts).

const SECRET_CONTEXT = "signudoc/webhook-secret/v1";
export const MAX_ENDPOINTS = 10;
const RECENT_DELIVERIES = 10;

export function readEndpointSecret(value: string): string | null {
  return decryptPrivateKey(value, secretKeyFor(SECRET_CONTEXT));
}

export type WebhookDelivery = {
  attempts: number;
  createdAt: number;
  event: string;
  id: string;
  lastAttemptAt: number | null;
  lastError: string | null;
  lastStatusCode: number | null;
  nextAttemptAt: number;
  status: "delivered" | "failed" | "pending";
};

export type WebhookEndpoint = {
  createdAt: number;
  events: WebhookEvent[];
  id: string;
  recentDeliveries: WebhookDelivery[];
  url: string;
};

export async function listWebhookEndpoints(
  database: DbExecutor = getDb(),
): Promise<WebhookEndpoint[]> {
  const endpoints = await queryMany<Omit<WebhookEndpoint, "recentDeliveries">>(
    database,
    `SELECT id, url, events, created_at AS "createdAt" FROM webhook_endpoints ORDER BY created_at`,
  );
  const deliveries = await queryMany<WebhookDelivery & { endpointId: string }>(
    database,
    `
      SELECT
        id, "endpointId", event, status, attempts, "lastStatusCode",
        "lastError", "lastAttemptAt", "nextAttemptAt", "createdAt"
      FROM (
        SELECT
          id, endpoint_id AS "endpointId", event, status, attempts,
          last_status_code AS "lastStatusCode", last_error AS "lastError",
          last_attempt_at AS "lastAttemptAt",
          next_attempt_at AS "nextAttemptAt", created_at AS "createdAt",
          row_number() OVER (
            PARTITION BY endpoint_id ORDER BY created_at DESC, id
          ) AS position
        FROM integration_deliveries
        WHERE target = 'webhook'
      ) ranked
      WHERE position <= $1
      ORDER BY "createdAt" DESC
    `,
    [RECENT_DELIVERIES],
  );

  return endpoints.map((endpoint) => ({
    ...endpoint,
    recentDeliveries: deliveries.filter(
      (delivery) => delivery.endpointId === endpoint.id,
    ),
  }));
}

export async function countWebhookEndpoints(
  database: DbExecutor = getDb(),
): Promise<number> {
  const row = await queryOne<{ count: string }>(
    database,
    "SELECT count(*) AS count FROM webhook_endpoints",
  );

  return Number(row?.count ?? 0);
}

/** Adds an endpoint and returns it with its secret, the only time it is shown. */
export async function createWebhookEndpoint(
  input: { createdBy: string; events: WebhookEvent[]; url: string },
  database: DbExecutor = getDb(),
): Promise<{ id: string; secret: string }> {
  const id = randomUUID();
  const secret = generateWebhookSecret();

  await database.query(
    `
      INSERT INTO webhook_endpoints (id, url, events, secret_encrypted, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      id,
      input.url,
      input.events,
      encryptPrivateKey(secret, secretKeyFor(SECRET_CONTEXT)),
      input.createdBy,
      Math.floor(Date.now() / 1000),
    ],
  );

  return { id, secret };
}

/** The removed endpoint's URL, or null when there was none. */
export async function deleteWebhookEndpoint(
  id: string,
  database: DbExecutor = getDb(),
): Promise<string | null> {
  const row = await queryOne<{ url: string }>(
    database,
    "DELETE FROM webhook_endpoints WHERE id = $1 RETURNING url",
    [id],
  );

  return row?.url ?? null;
}

export async function webhookEndpointExists(
  id: string,
  database: DbExecutor = getDb(),
): Promise<boolean> {
  return (
    (await queryOne(database, "SELECT 1 FROM webhook_endpoints WHERE id = $1", [
      id,
    ])) !== null
  );
}
