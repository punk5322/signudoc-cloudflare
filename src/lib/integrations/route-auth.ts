import { NextResponse } from "next/server";

import { requireAdminSession } from "../auth/admin.ts";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "../security/route-controls.ts";
import { isHostedMode } from "../utils/env.ts";

/**
 * Webhooks and Drive filing see every envelope on the site, so only an
 * administrator of a self-run install may manage them: the hosted service's
 * accounts are strangers to each other.
 */
export async function requireIntegrationAdmin(
  request: Request,
  { rateLimited = true }: { rateLimited?: boolean } = {},
) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  if (isHostedMode()) {
    return NextResponse.json(
      { error: "Integrations are not available on this site." },
      { status: 409 },
    );
  }

  if (rateLimited) {
    const limited = await applyRateLimit({
      category: "integration_settings",
      key: buildRateLimitKey(["integrations", session.user.id]),
      limit: 30,
      request,
      userId: session.user.id,
      windowMs: 10 * 60 * 1000,
    });

    if (limited) {
      return limited;
    }
  }

  return session;
}
