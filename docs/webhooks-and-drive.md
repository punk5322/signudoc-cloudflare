# Webhooks and Google Drive

Both are set up by an administrator under Settings, Integrations. Neither is available in hosted mode.

## Webhooks

Add an HTTPS URL and pick the events to send:

| Event                | When                                         | `data` has              |
| -------------------- | -------------------------------------------- | ----------------------- |
| `envelope.sent`      | The sender sent the envelope                 | `envelope`              |
| `envelope.viewed`    | A signer opened it for the first time        | `envelope`, `signer`    |
| `envelope.signed`    | A signer signed                              | `envelope`, `signer`    |
| `envelope.completed` | Everyone signed and the final PDF was sealed | `envelope`, `documents` |
| `envelope.declined`  | A signer declined                            | `envelope`, `signer`    |
| `envelope.voided`    | The sender voided it                         | `envelope`              |
| `envelope.expired`   | Its deadline passed                          | `envelope`              |

Each event is a `POST` with a JSON body:

```json
{
  "id": "5f0c...",
  "type": "envelope.signed",
  "createdAt": "2026-11-18T17:02:11.000Z",
  "data": {
    "envelope": {
      "id": "...",
      "title": "NDA",
      "status": "sent",
      "url": "https://sign.example.com/envelopes/..."
    },
    "signer": {
      "id": "...",
      "name": "Pat Lee",
      "email": "pat@example.com",
      "order": 1
    }
  }
}
```

`id` stays the same on every retry of one delivery, so use it to ignore repeats. For `envelope.completed`, `documents.signedPdfUrl` and `documents.certificateUrl` point at the sender's download route: they need a signed-in sender, so fetch the files from inside SignuDoc or file them with the Google Drive integration below. "Send test" posts `{"type": "test"}`.

A `2xx` answer within 15 seconds counts as delivered. Anything else, including a redirect, is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours and 24 hours, then marked failed. Settings shows the last ten deliveries of each endpoint. A retry that falls due while the app is asleep is sent at the next event or by the daily job.

Only public addresses are accepted: no `localhost`, private (RFC 1918), link-local, carrier-grade NAT or IPv6 local ranges, no `.internal`, `.local` or single-label names, none of the site's own hosts, and a host name is resolved and checked again before every request.

### Verifying a request

Every request carries `X-Signature: t=<unix seconds>,v1=<hex>`. `v1` is HMAC-SHA256, keyed with the endpoint's `whsec_...` secret (shown once, when the endpoint is added), over the timestamp, a dot and the raw body exactly as received. In Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, header, rawBody) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false; // 5 minutes
  const expected = createHmac("sha256", secret)
    .update(`${t}.${rawBody}`)
    .digest();
  const given = Buffer.from(parts.v1 ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Verify before parsing the JSON, since re-serializing changes the bytes. A lost secret cannot be shown again: remove the endpoint and add it anew.

## Google Drive

When an envelope is completed, the signed PDF and its certificate are uploaded to a folder in one Google Drive. The uploads go through the same queue and retries as webhooks.

### Setting up the OAuth client (once, in Google Cloud)

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project and enable the **Google Drive API** (APIs & Services, Library).
2. Under **Google Auth Platform** (OAuth consent screen), set the app name and support email, choose **Internal** for a Google Workspace organization or **External** otherwise, and add the scope `https://www.googleapis.com/auth/drive.file`. An External app left in Testing mode must list the connecting Google account as a test user, and its refresh tokens expire after 7 days: publish it to keep the connection.
3. Under **Clients**, create an OAuth client of type **Web application** with the authorized redirect URI `<APP_URL>/api/admin/google-drive/callback`, for example `https://sign.example.com/api/admin/google-drive/callback`.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the deployment (on Cloudflare, `npx wrangler secret put` each) and restart.

### Connecting

Settings, Integrations, **Connect Google Drive**. After consent the site makes a folder named after the organization at the top of that Drive and files there. The `drive.file` scope lets the site see only what it made, so a folder ID pasted in later must be one of those (a folder from an earlier connection, say). **Disconnect** revokes the token at Google and forgets it.

The refresh token, like each webhook secret, is stored encrypted (AES-256-GCM) with a key derived from `BETTER_AUTH_SECRET` by HKDF, the same scheme as the seal key. If that secret changes, connect Drive again and re-add the webhooks.
