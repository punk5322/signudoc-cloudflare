import { randomBytes, timingSafeEqual } from "node:crypto";

import { getDb, queryOne, type DbExecutor } from "../db/connection.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "../services/seal-identity.ts";
import { getEnv, type EnvSource } from "../utils/env.ts";

// Filing finished envelopes in Google Drive. An administrator connects one
// Google account with the OAuth web flow (scope drive.file: the app sees
// only the files and folders it made itself). The refresh token is kept in
// google_drive_connection, encrypted with a key derived from the auth
// secret the same way as the seal key (seal-identity.ts). Uploads go
// through the delivery queue in deliveries.ts, so a failed one is retried.

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const CALLBACK_PATH = "/api/admin/google-drive/callback";
export const STATE_COOKIE = "signudoc_google_oauth_state";
const TOKEN_CONTEXT = "signudoc/google-drive-token/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_TYPE = "application/vnd.google-apps.folder";
const TIMEOUT_MS = 30_000;

export type GoogleClient = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/** The OAuth client from GOOGLE_CLIENT_ID and _SECRET, or null when unset. */
export function getGoogleClient(
  env: EnvSource = process.env,
): GoogleClient | null {
  const { appUrl, google } = getEnv(env);

  if (!google.clientId || !google.clientSecret || !appUrl) {
    return null;
  }

  return {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    redirectUri: new URL(CALLBACK_PATH, appUrl).toString(),
  };
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The state Google sent back must be the one this browser was given in a
 * cookie when it set out, so a callback someone else started (login CSRF:
 * connecting the attacker's Drive) is refused.
 */
export function isValidOAuthState(
  returned: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!returned || !expected || returned.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(returned), Buffer.from(expected));
}

export function buildAuthorizationUrl(
  client: GoogleClient,
  state: string,
): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");

  url.search = new URLSearchParams({
    access_type: "offline",
    client_id: client.clientId,
    // Without it Google sends a refresh token only on the first consent.
    prompt: "consent",
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    state,
  }).toString();

  return url.toString();
}

export function encryptToken(
  token: string,
  env: EnvSource = process.env,
): string {
  return encryptPrivateKey(token, secretKeyFor(TOKEN_CONTEXT, env));
}

export function decryptToken(
  value: string,
  env: EnvSource = process.env,
): string | null {
  return decryptPrivateKey(value, secretKeyFor(TOKEN_CONTEXT, env));
}

export class GoogleApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
  }
}

async function googleJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    // Google's error bodies name the problem but never echo a token.
    const detail = (await response.text().catch(() => "")).slice(0, 300);

    throw new GoogleApiError(
      `${what} failed (${String(response.status)}): ${detail}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

async function tokenRequest(
  client: GoogleClient,
  params: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string }> {
  const response = await fetch(TOKEN_URL, {
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      ...params,
    }),
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  return googleJson(response, "Google sign-in");
}

export function exchangeCode(client: GoogleClient, code: string) {
  return tokenRequest(client, {
    code,
    grant_type: "authorization_code",
    redirect_uri: client.redirectUri,
  });
}

export async function getAccessToken(
  client: GoogleClient,
  refreshToken: string,
): Promise<string> {
  return (
    await tokenRequest(client, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })
  ).access_token;
}

export async function revokeToken(token: string): Promise<void> {
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    body: new URLSearchParams({ token }),
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // 400 means the token was already revoked or expired: just as good.
  if (!response.ok && response.status !== 400) {
    throw new GoogleApiError(
      "Revoking the Google token failed.",
      response.status,
    );
  }
}

function authorized(accessToken: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

export type DriveFolder = { id: string; name: string };

export async function createFolder(
  accessToken: string,
  name: string,
  parentId?: string,
): Promise<DriveFolder> {
  const response = await fetch(
    `${DRIVE_API}/files?fields=id,name&supportsAllDrives=true`,
    authorized(accessToken, {
      body: JSON.stringify({
        mimeType: FOLDER_TYPE,
        name,
        ...(parentId ? { parents: [parentId] } : {}),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );

  return googleJson(response, "Creating a Drive folder");
}

/** A folder the app can reach, or null. drive.file reaches only its own. */
export async function getFolder(
  accessToken: string,
  folderId: string,
): Promise<DriveFolder | null> {
  const response = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed&supportsAllDrives=true`,
    authorized(accessToken),
  );

  if (response.status === 404) {
    return null;
  }

  const file = await googleJson<
    DriveFolder & { mimeType: string; trashed?: boolean }
  >(response, "Reading the Drive folder");

  return file.mimeType === FOLDER_TYPE && !file.trashed
    ? { id: file.id, name: file.name }
    : null;
}

export async function getAccountEmail(
  accessToken: string,
): Promise<string | null> {
  const response = await fetch(
    `${DRIVE_API}/about?fields=user(emailAddress)`,
    authorized(accessToken),
  ).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  const about = (await response.json().catch(() => null)) as {
    user?: { emailAddress?: string };
  } | null;

  return about?.user?.emailAddress ?? null;
}

export async function uploadPdf(
  accessToken: string,
  {
    body,
    name,
    parentId,
  }: { body: Uint8Array; name: string; parentId: string },
): Promise<{ id: string }> {
  const boundary = `signudoc-${randomBytes(12).toString("hex")}`;
  const multipart = new Blob([
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify({ mimeType: "application/pdf", name, parents: [parentId] }),
    `\r\n--${boundary}\r\ncontent-type: application/pdf\r\n\r\n`,
    body.slice(),
    `\r\n--${boundary}--`,
  ]);
  const response = await fetch(
    `${UPLOAD_API}?uploadType=multipart&fields=id&supportsAllDrives=true`,
    authorized(accessToken, {
      body: multipart,
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      method: "POST",
    }),
  );

  return googleJson(response, "Uploading to Drive");
}

export type DriveConnection = {
  accountEmail: string | null;
  connectedAt: number;
  folderId: string;
  folderName: string | null;
  lastUploadAt: number | null;
  lastUploadError: string | null;
  refreshTokenEncrypted: string;
  subfolderPerEnvelope: boolean;
};

export async function getDriveConnection(
  database: DbExecutor = getDb(),
): Promise<DriveConnection | null> {
  return queryOne<DriveConnection>(
    database,
    `
      SELECT
        account_email AS "accountEmail",
        connected_at AS "connectedAt",
        folder_id AS "folderId",
        folder_name AS "folderName",
        last_upload_at AS "lastUploadAt",
        last_upload_error AS "lastUploadError",
        refresh_token_encrypted AS "refreshTokenEncrypted",
        subfolder_per_envelope AS "subfolderPerEnvelope"
      FROM google_drive_connection
      WHERE id = 1
    `,
  );
}

export async function saveDriveConnection(
  input: {
    accountEmail: string | null;
    connectedBy: string;
    folder: DriveFolder;
    refreshToken: string;
  },
  database: DbExecutor = getDb(),
): Promise<void> {
  await database.query(
    `
      INSERT INTO google_drive_connection (
        id, refresh_token_encrypted, account_email, folder_id, folder_name,
        connected_by, connected_at
      ) VALUES (1, $1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
        account_email = EXCLUDED.account_email,
        folder_id = EXCLUDED.folder_id,
        folder_name = EXCLUDED.folder_name,
        connected_by = EXCLUDED.connected_by,
        connected_at = EXCLUDED.connected_at,
        last_upload_at = NULL,
        last_upload_error = NULL
    `,
    [
      encryptToken(input.refreshToken),
      input.accountEmail,
      input.folder.id,
      input.folder.name,
      input.connectedBy,
      Math.floor(Date.now() / 1000),
    ],
  );
}

/** The access token for the stored connection, or an error saying why not. */
export async function accessTokenForConnection(
  connection: DriveConnection,
): Promise<string> {
  const client = getGoogleClient();

  if (!client) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.");
  }

  const refreshToken = decryptToken(connection.refreshTokenEncrypted);

  if (!refreshToken) {
    throw new Error(
      "The stored Google token cannot be read (the auth secret changed). Connect Google Drive again.",
    );
  }

  return getAccessToken(client, refreshToken);
}
