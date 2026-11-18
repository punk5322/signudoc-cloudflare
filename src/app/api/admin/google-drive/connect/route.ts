import { NextResponse } from "next/server";

import {
  buildAuthorizationUrl,
  createOAuthState,
  getGoogleClient,
  STATE_COOKIE,
} from "@/lib/integrations/google-drive";
import { requireIntegrationAdmin } from "@/lib/integrations/route-auth";
import { isProduction, resolveAppUrl } from "@/lib/utils/env";

// "Connect Google Drive": sends the administrator to Google's consent page.
// The state goes along and into a short-lived cookie; ../callback checks
// that the two match.

export async function GET(request: Request) {
  const session = await requireIntegrationAdmin(request);

  if (session instanceof Response) {
    return session;
  }

  const client = getGoogleClient();

  if (!client) {
    return NextResponse.redirect(
      new URL(
        "/settings?drive=not_configured#integrations",
        resolveAppUrl() ?? request.url,
      ),
    );
  }

  const state = createOAuthState();
  const response = NextResponse.redirect(buildAuthorizationUrl(client, state));

  response.headers.set("cache-control", "private, no-store");
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: "/api/admin/google-drive",
    // Lax, so the cookie comes back on Google's top-level redirect.
    sameSite: "lax",
    secure: isProduction(process.env),
  });

  return response;
}
