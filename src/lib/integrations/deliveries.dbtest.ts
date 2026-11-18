import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests, withTransaction } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { recordAuditEvent } from "../services/audit.ts";
import { processDueDeliveries } from "./deliveries.ts";
import { verifyWebhookSignature } from "./webhook-signing.ts";
import { createWebhookEndpoint } from "./webhooks.ts";

// The delivery queue against a real Postgres: deliveries are queued with
// the audit event (and not when it rolls back), signed, retried after a
// failure and marked delivered. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

// A public address, so no DNS lookup is needed; fetch is mocked anyway.
const HOOK_URL = "https://203.0.113.10/hook";

let database: pg.Pool;
let userId: string;
let envelopeId: string;

before(async () => {
  database = await openTestDatabase();
  replaceDbPoolForTests(database);
  userId = randomUUID();
  envelopeId = randomUUID();
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, 'Lease', 'sent', 'test/x.pdf', 'lease.pdf', 10, 1, $3)
    `,
    [envelopeId, userId, "a".repeat(64)],
  );
});

beforeEach(async () => {
  await database.query("delete from webhook_endpoints");
});

after(async () => {
  await database.query("delete from webhook_endpoints");
  await database.query(`delete from public."user" where id = $1`, [userId]);
  await database.end();
});

function signedEvent() {
  return {
    actorType: "signer" as const,
    envelopeId,
    event: "signed" as const,
    metadata: {
      signerEmail: "riley@example.test",
      signerId: "signer-1",
      signerName: "Riley",
      signerOrder: 1,
    },
  };
}

async function deliveriesFor(endpointId: string) {
  return (
    await database.query<{
      attempts: number;
      last_error: string | null;
      next_attempt_at: number;
      status: string;
    }>(
      "select status, attempts, next_attempt_at, last_error from integration_deliveries where endpoint_id = $1",
      [endpointId],
    )
  ).rows;
}

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.fail("timed out");
}

test("an event queues a delivery for subscribed endpoints only, and not on rollback", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response(null, { status: 204 })),
  );

  const subscribed = await createWebhookEndpoint(
    { createdBy: userId, events: ["signed"], url: HOOK_URL },
    database,
  );
  const other = await createWebhookEndpoint(
    { createdBy: userId, events: ["completed"], url: HOOK_URL },
    database,
  );

  await assert.rejects(
    withTransaction(async (client) => {
      await recordAuditEvent(signedEvent(), client);
      throw new Error("roll back");
    }, database),
  );
  assert.equal((await deliveriesFor(subscribed.id)).length, 0);

  await recordAuditEvent(signedEvent(), database);

  assert.equal((await deliveriesFor(other.id)).length, 0);
  // Sent by itself once the event committed.
  await waitFor(
    async () => (await deliveriesFor(subscribed.id))[0]?.status === "delivered",
  );
});

test("a failed delivery is retried later, signed the same way, then delivered", async (t) => {
  const endpoint = await createWebhookEndpoint(
    { createdBy: userId, events: ["signed"], url: HOOK_URL },
    database,
  );
  const requests: { body: string; headers: Headers }[] = [];
  let status = 500;

  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    requests.push({
      body: String(init.body),
      headers: new Headers(init.headers),
    });

    return Promise.resolve(new Response(null, { status }));
  });

  // Queued directly, so the background run does not race this test.
  await database.query(
    `
      insert into integration_deliveries (
        id, target, endpoint_id, event, envelope_id, next_attempt_at, created_at
      ) values ($1, 'webhook', $2, 'signed', $3, 0, 0)
    `,
    [randomUUID(), endpoint.id, envelopeId],
  );

  const started = Math.floor(Date.now() / 1000);

  await processDueDeliveries(database);

  let [row] = await deliveriesFor(endpoint.id);

  assert.equal(row?.status, "pending");
  assert.equal(row?.attempts, 1);
  assert.equal(row?.last_error, "The endpoint answered 500.");
  assert.ok(row!.next_attempt_at >= started + 60);

  // Not due yet: nothing is sent.
  await processDueDeliveries(database);
  assert.equal(requests.length, 1);

  await database.query(
    "update integration_deliveries set next_attempt_at = 0 where endpoint_id = $1",
    [endpoint.id],
  );
  status = 200;
  await processDueDeliveries(database);

  [row] = await deliveriesFor(endpoint.id);
  assert.equal(row?.status, "delivered");
  assert.equal(row?.attempts, 2);
  assert.equal(requests.length, 2);

  for (const request of requests) {
    const payload = JSON.parse(request.body) as {
      data: { envelope: { id: string } };
      type: string;
    };

    assert.equal(payload.type, "envelope.signed");
    assert.equal(payload.data.envelope.id, envelopeId);
    assert.ok(
      verifyWebhookSignature(
        endpoint.secret,
        request.headers.get("x-signature"),
        request.body,
      ),
    );
  }

  assert.equal(requests[0]!.body, requests[1]!.body);
});
