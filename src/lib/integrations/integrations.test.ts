import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { buildWebhookPayload } from "./deliveries.ts";
import {
  buildAuthorizationUrl,
  createOAuthState,
  decryptToken,
  DRIVE_SCOPE,
  encryptToken,
  getGoogleClient,
  isValidOAuthState,
} from "./google-drive.ts";
import { RETRY_DELAYS_SECONDS, retryDelaySeconds } from "./queue.ts";
import {
  generateWebhookSecret,
  signWebhookBody,
  verifyWebhookSignature,
} from "./webhook-signing.ts";
import {
  checkWebhookTarget,
  checkWebhookUrl,
  isBlockedAddress,
} from "./webhook-url.ts";

test("a signature is HMAC-SHA256 over timestamp.body and verifies", () => {
  const secret = generateWebhookSecret();
  const body = '{"type":"envelope.completed"}';
  const header = signWebhookBody(secret, body, 1_800_000_000);
  const expected = createHmac("sha256", secret)
    .update(`1800000000.${body}`)
    .digest("hex");

  assert.equal(header, `t=1800000000,v1=${expected}`);
  assert.ok(
    verifyWebhookSignature(secret, header, body, { now: 1_800_000_100 }),
  );
});

test("verification refuses a changed body, wrong secret, stale or malformed header", () => {
  const secret = generateWebhookSecret();
  const body = "{}";
  const header = signWebhookBody(secret, body, 1_800_000_000);
  const now = { now: 1_800_000_000 };

  assert.equal(verifyWebhookSignature(secret, header, "{ }", now), false);
  assert.equal(
    verifyWebhookSignature(generateWebhookSecret(), header, body, now),
    false,
  );
  assert.equal(
    verifyWebhookSignature(secret, header, body, { now: 1_800_000_000 + 301 }),
    false,
  );
  assert.equal(verifyWebhookSignature(secret, null, body, now), false);
  assert.equal(
    verifyWebhookSignature(secret, "t=1800000000,v1=zz", body, now),
    false,
  );
});

test("webhook URLs must be public https", () => {
  const env = {
    APP_URL: "https://sign.example.com",
    S3_ENDPOINT: "http://storage.signudoc.internal",
  };

  assert.equal(
    checkWebhookUrl("https://hooks.example.org/x?token=1", env),
    null,
  );
  assert.equal(checkWebhookUrl("https://93.184.216.34/hook", env), null);

  for (const blocked of [
    "http://hooks.example.org/x",
    "ftp://hooks.example.org/x",
    "https://user:pw@hooks.example.org/",
    "https://hooks.example.org:8443/",
    "https://localhost/",
    "https://app.localhost/",
    "https://127.0.0.1/",
    "https://10.1.2.3/",
    "https://172.20.0.1/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/",
    "https://0.0.0.0/",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://[fe80::1]/",
    "https://[::ffff:10.0.0.1]/",
    "https://metadata.google.internal/",
    "https://storage.signudoc.internal/",
    "https://printer.local/",
    "https://intranet/",
    "https://sign.example.com/api/internal/retention",
    "not a url",
  ]) {
    assert.notEqual(checkWebhookUrl(blocked, env), null, blocked);
  }
});

test("a host name that resolves to a private address is refused", async () => {
  const resolveTo = (addresses: string[]) => ({
    env: {},
    resolve: () => Promise.resolve(addresses),
  });

  assert.equal(
    await checkWebhookTarget(
      "https://hooks.example.org/",
      resolveTo(["93.184.216.34"]),
    ),
    null,
  );
  assert.notEqual(
    await checkWebhookTarget(
      "https://rebind.example.org/",
      resolveTo(["93.184.216.34", "10.0.0.5"]),
    ),
    null,
  );
  assert.notEqual(
    await checkWebhookTarget("https://gone.example.org/", {
      env: {},
      resolve: () => Promise.reject(new Error("ENOTFOUND")),
    }),
    null,
  );
  assert.equal(isBlockedAddress("2606:4700::1111"), false);
  assert.equal(isBlockedAddress("not-an-ip"), true);
});

test("retries back off, then stop", () => {
  assert.equal(retryDelaySeconds(1), 60);
  assert.equal(retryDelaySeconds(2), 300);

  for (let attempt = 2; attempt <= RETRY_DELAYS_SECONDS.length; attempt++) {
    assert.ok(retryDelaySeconds(attempt)! > retryDelaySeconds(attempt - 1)!);
  }

  assert.equal(retryDelaySeconds(RETRY_DELAYS_SECONDS.length + 1), null);
});

test("payloads carry the envelope, the signer for signer events, links on completion", () => {
  const envelope = { id: "env-1", status: "completed", title: "NDA" };
  const metadata = {
    signerEmail: "pat@example.com",
    signerId: "s-1",
    signerName: "Pat Lee",
    signerOrder: 1,
  };
  const signed = buildWebhookPayload({
    appUrl: "https://sign.example.com",
    deliveryId: "d-1",
    envelope,
    event: "signed",
    metadata,
    occurredAt: 1_800_000_000,
  });

  assert.deepEqual(signed, {
    createdAt: "2027-01-15T08:00:00.000Z",
    data: {
      envelope: {
        ...envelope,
        url: "https://sign.example.com/envelopes/env-1",
      },
      signer: {
        email: "pat@example.com",
        id: "s-1",
        name: "Pat Lee",
        order: 1,
      },
    },
    id: "d-1",
    type: "envelope.signed",
  });

  const completed = buildWebhookPayload({
    appUrl: "https://sign.example.com",
    deliveryId: "d-2",
    envelope,
    event: "completed",
    metadata: null,
    occurredAt: 1_800_000_000,
  });

  assert.equal(completed.type, "envelope.completed");
  assert.equal(completed.data.signer, undefined);
  assert.deepEqual(completed.data.documents, {
    certificateUrl:
      "https://sign.example.com/api/envelopes/env-1/download?type=evidence",
    signedPdfUrl:
      "https://sign.example.com/api/envelopes/env-1/download?type=signed",
  });

  // A void names no signer even though its metadata may.
  const voided = buildWebhookPayload({
    appUrl: null,
    deliveryId: "d-3",
    envelope,
    event: "voided",
    metadata,
    occurredAt: 1_800_000_000,
  });

  assert.equal(voided.data.signer, undefined);
  assert.equal(voided.data.envelope?.url, null);

  assert.equal(
    buildWebhookPayload({
      appUrl: null,
      deliveryId: "d-4",
      envelope: null,
      event: "test",
      metadata: null,
      occurredAt: 1_800_000_000,
    }).type,
    "test",
  );
});

test("OAuth state must match the cookie exactly", () => {
  const state = createOAuthState();

  assert.ok(state.length >= 40);
  assert.notEqual(createOAuthState(), state);
  assert.equal(isValidOAuthState(state, state), true);
  assert.equal(isValidOAuthState(state, createOAuthState()), false);
  assert.equal(isValidOAuthState(state, null), false);
  assert.equal(isValidOAuthState(null, state), false);
  assert.equal(isValidOAuthState("", ""), false);
  assert.equal(isValidOAuthState(`${state}x`, state), false);
});

test("the Google client needs both env vars and builds an offline drive.file URL", () => {
  assert.equal(getGoogleClient({ APP_URL: "https://sign.example.com" }), null);
  assert.equal(
    getGoogleClient({
      APP_URL: "https://sign.example.com",
      GOOGLE_CLIENT_ID: "id",
    }),
    null,
  );

  const client = getGoogleClient({
    APP_URL: "https://sign.example.com",
    GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "shh",
  });

  assert.ok(client);
  assert.equal(
    client.redirectUri,
    "https://sign.example.com/api/admin/google-drive/callback",
  );

  const url = new URL(buildAuthorizationUrl(client, "state-123"));

  assert.equal(url.searchParams.get("scope"), DRIVE_SCOPE);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("redirect_uri"), client.redirectUri);
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("refresh tokens round-trip through encryption and need the same auth secret", () => {
  const env = { BETTER_AUTH_SECRET: "a".repeat(40) };
  const token = "1//0refresh-token-value";
  const sealed = encryptToken(token, env);

  assert.ok(!sealed.includes(token));
  assert.notEqual(encryptToken(token, env), sealed);
  assert.equal(decryptToken(sealed, env), token);
  assert.equal(
    decryptToken(sealed, { BETTER_AUTH_SECRET: "b".repeat(40) }),
    null,
  );
  const [version, iv, tag, body] = sealed.split(".");
  const flipped = `${body![0] === "A" ? "B" : "A"}${body!.slice(1)}`;

  assert.equal(decryptToken([version, iv, tag, flipped].join("."), env), null);
});
