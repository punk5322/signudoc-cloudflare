import { NextResponse } from "next/server";
import { z } from "zod";

import { kickDeliveries } from "@/lib/integrations/deliveries";
import { enqueueTestDelivery } from "@/lib/integrations/queue";
import { requireIntegrationAdmin } from "@/lib/integrations/route-auth";
import {
  deleteWebhookEndpoint,
  webhookEndpointExists,
} from "@/lib/integrations/webhooks";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { recordAdminActivity } from "@/lib/services/admin-activity";

// One webhook endpoint: send it a test event, or remove it.

type RouteContext = { params: Promise<{ id: string }> };

const noStore = { "cache-control": "private, no-store" };
const actionSchema = z.object({ action: z.literal("test") });

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "webhook_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure while managing a webhook.",
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { headers: noStore, status: 500 },
  );
}

const notFound = () =>
  NextResponse.json(
    { error: "That webhook no longer exists." },
    { headers: noStore, status: 404 },
  );

export async function POST(request: Request, context: RouteContext) {
  const session = await requireIntegrationAdmin(request);

  if (session instanceof Response) {
    return session;
  }

  const { id } = await context.params;

  if (!actionSchema.safeParse(await request.json().catch(() => null)).success) {
    return NextResponse.json(
      { error: "Unknown action." },
      { headers: noStore, status: 400 },
    );
  }

  try {
    if (!(await webhookEndpointExists(id))) {
      return notFound();
    }

    await enqueueTestDelivery(id);
    kickDeliveries();

    return NextResponse.json(
      { queued: true },
      { headers: noStore, status: 202 },
    );
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const session = await requireIntegrationAdmin(request);

  if (session instanceof Response) {
    return session;
  }

  const { id } = await context.params;

  try {
    const url = await deleteWebhookEndpoint(id);

    if (!url) {
      return notFound();
    }

    await recordAdminActivity({
      event: "webhook_endpoint_removed",
      metadata: { endpointId: id, host: new URL(url).host },
      request,
      user: session.user,
    });

    return new NextResponse(null, { headers: noStore, status: 204 });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
