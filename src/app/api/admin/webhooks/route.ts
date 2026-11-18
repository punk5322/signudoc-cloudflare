import { NextResponse } from "next/server";
import { z } from "zod";

import { WEBHOOK_EVENTS } from "@/lib/integrations/queue";
import { requireIntegrationAdmin } from "@/lib/integrations/route-auth";
import { checkWebhookTarget } from "@/lib/integrations/webhook-url";
import {
  countWebhookEndpoints,
  createWebhookEndpoint,
  listWebhookEndpoints,
  MAX_ENDPOINTS,
} from "@/lib/integrations/webhooks";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { recordAdminActivity } from "@/lib/services/admin-activity";

// Webhook endpoints for the Integrations section of Settings.
// Administrators only. The signing secret is in the answer to POST, once.

const noStore = { "cache-control": "private, no-store" };

const createSchema = z.object({
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  url: z.string().trim().min(1).max(2000),
});

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "webhook_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure while managing webhooks.",
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { headers: noStore, status: 500 },
  );
}

export async function GET(request: Request) {
  const session = await requireIntegrationAdmin(request, {
    rateLimited: false,
  });

  if (session instanceof Response) {
    return session;
  }

  try {
    return NextResponse.json(
      { endpoints: await listWebhookEndpoints() },
      { headers: noStore },
    );
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

export async function POST(request: Request) {
  const session = await requireIntegrationAdmin(request);

  if (session instanceof Response) {
    return session;
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a URL and pick at least one event." },
      { headers: noStore, status: 400 },
    );
  }

  try {
    const problem = await checkWebhookTarget(parsed.data.url);

    if (problem) {
      return NextResponse.json(
        { error: problem },
        { headers: noStore, status: 400 },
      );
    }

    if ((await countWebhookEndpoints()) >= MAX_ENDPOINTS) {
      return NextResponse.json(
        { error: `A site can have up to ${String(MAX_ENDPOINTS)} webhooks.` },
        { headers: noStore, status: 409 },
      );
    }

    const created = await createWebhookEndpoint({
      createdBy: session.user.id,
      events: [...new Set(parsed.data.events)],
      url: parsed.data.url,
    });

    await recordAdminActivity({
      event: "webhook_endpoint_added",
      // The host only: a URL's path or query can carry the receiver's token.
      metadata: {
        endpointId: created.id,
        events: parsed.data.events,
        host: new URL(parsed.data.url).host,
      },
      request,
      user: session.user,
    });

    return NextResponse.json(
      { endpoint: { id: created.id }, secret: created.secret },
      { headers: noStore, status: 201 },
    );
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
