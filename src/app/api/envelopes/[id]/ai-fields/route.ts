import { NextResponse } from "next/server";

import {
  AiFieldsError,
  MAX_AI_FIELDS_PAGES,
  parseFieldSuggestions,
  requestFieldSuggestions,
} from "@/lib/ai-fields";
import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import {
  EnvelopeDocumentAccessError,
  getDraftEnvelopeDocumentForUser,
  getPrepareEnvelopeDataForUser,
} from "@/lib/envelopes";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { getEnv } from "@/lib/utils/env";

export const maxDuration = 120;

// Suggests fields for the sender's own draft. Returns them without saving:
// the editor adds them as unsaved fields the sender can change or delete.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;
  const apiKey = getEnv().ai.anthropicApiKey;

  if (!apiKey) {
    return NextResponse.json(
      { error: "An admin must set ANTHROPIC_API_KEY to place fields with AI." },
      { status: 503 },
    );
  }

  const rateLimitResponse = await applyRateLimit({
    category: "ai_fields_rate_limited",
    key: buildRateLimitKey(["ai-fields", session.user.id]),
    limit: 20,
    message: "Too many AI requests. Please try again later.",
    request,
    userId: session.user.id,
    windowMs: 60 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const database = getDb();
    // Both loads are scoped to the signed-in user's own envelopes.
    const record = await getPrepareEnvelopeDataForUser(session.user.id, id, {
      database,
    });

    if (!record) {
      return NextResponse.json(
        { error: "Envelope not found." },
        { status: 404 },
      );
    }

    if (record.status !== "draft") {
      return NextResponse.json(
        { error: "Fields can only be placed on a draft." },
        { status: 409 },
      );
    }

    const pageCount = record.pages.length;

    if (pageCount > MAX_AI_FIELDS_PAGES) {
      return NextResponse.json(
        {
          error: `AI placement works on documents of up to ${String(MAX_AI_FIELDS_PAGES)} pages.`,
        },
        { status: 413 },
      );
    }

    const document = await getDraftEnvelopeDocumentForUser(
      session.user.id,
      id,
      { database },
    );
    const output = await requestFieldSuggestions({
      apiKey,
      pageCount,
      pdf: document.body,
      signers: record.signers,
    });

    return NextResponse.json(
      {
        fields: parseFieldSuggestions(output, {
          pageCount,
          signers: record.signers,
        }),
      },
      { headers: { "cache-control": "private, no-store" }, status: 200 },
    );
  } catch (error) {
    if (
      error instanceof AiFieldsError ||
      error instanceof EnvelopeDocumentAccessError
    ) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "ai_fields_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while suggesting fields with AI.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to place fields with AI." },
      { status: 500 },
    );
  }
}
