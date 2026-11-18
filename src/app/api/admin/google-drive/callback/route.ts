import { NextResponse } from "next/server";

import {
  createFolder,
  decryptToken,
  exchangeCode,
  getAccountEmail,
  getDriveConnection,
  getGoogleClient,
  isValidOAuthState,
  revokeToken,
  saveDriveConnection,
  STATE_COOKIE,
} from "@/lib/integrations/google-drive";
import { requireIntegrationAdmin } from "@/lib/integrations/route-auth";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { recordAdminActivity } from "@/lib/services/admin-activity";
import { getBranding } from "@/lib/settings";
import { resolveAppUrl } from "@/lib/utils/env";

// Where Google sends the administrator back after consent. Register this
// path (after APP_URL) as an authorized redirect URI of the OAuth client.
// On success the app makes a folder named after the organization in the
// connected Drive and files finished envelopes there.

function backToSettings(request: Request, outcome: string) {
  const response = NextResponse.redirect(
    new URL(
      `/settings?drive=${outcome}#integrations`,
      resolveAppUrl() ?? request.url,
    ),
  );

  response.headers.set("cache-control", "private, no-store");
  response.cookies.set(STATE_COOKIE, "", {
    maxAge: 0,
    path: "/api/admin/google-drive",
  });

  return response;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");

    if (key === name) {
      return value.join("=");
    }
  }

  return null;
}

export async function GET(request: Request) {
  const session = await requireIntegrationAdmin(request);

  if (session instanceof Response) {
    return session;
  }

  const params = new URL(request.url).searchParams;

  if (
    !isValidOAuthState(params.get("state"), readCookie(request, STATE_COOKIE))
  ) {
    return backToSettings(request, "state_mismatch");
  }

  const code = params.get("code");
  const client = getGoogleClient();

  if (!code || !client) {
    return backToSettings(request, client ? "denied" : "not_configured");
  }

  try {
    const tokens = await exchangeCode(client, code);

    if (!tokens.refresh_token) {
      return backToSettings(request, "no_refresh_token");
    }

    const branding = await getBranding();
    const folder = await createFolder(
      tokens.access_token,
      branding.organizationName ?? branding.productName,
    );
    const previous = await getDriveConnection();

    await saveDriveConnection({
      accountEmail: await getAccountEmail(tokens.access_token),
      connectedBy: session.user.id,
      folder,
      refreshToken: tokens.refresh_token,
    });

    // A token replaced by this connection is no longer needed anywhere.
    const previousToken =
      previous && decryptToken(previous.refreshTokenEncrypted);

    if (previousToken && previousToken !== tokens.refresh_token) {
      await revokeToken(previousToken).catch(() => undefined);
    }

    await recordAdminActivity({
      event: "google_drive_connected",
      metadata: { folderId: folder.id, folderName: folder.name },
      request,
      user: session.user,
    });

    return backToSettings(request, "connected");
  } catch (error) {
    logRouteError(error, {
      category: "google_drive_connect_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Connecting Google Drive failed.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return backToSettings(request, "failed");
  }
}
