import { NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/connection";
import {
  accessTokenForConnection,
  CALLBACK_PATH,
  decryptToken,
  getDriveConnection,
  getFolder,
  getGoogleClient,
  revokeToken,
} from "@/lib/integrations/google-drive";
import { requireIntegrationAdmin } from "@/lib/integrations/route-auth";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { recordAdminActivity } from "@/lib/services/admin-activity";
import { resolveAppUrl } from "@/lib/utils/env";

// Google Drive filing for the Integrations section of Settings: its status,
// the destination folder, and disconnecting. Connecting is ./connect.

const noStore = { "cache-control": "private, no-store" };

const updateSchema = z
  .object({
    folderId: z
      .string()
      .trim()
      .regex(/^[\w-]{10,200}$/, "That does not look like a Drive folder ID.")
      .optional(),
    subfolderPerEnvelope: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.folderId !== undefined || value.subfolderPerEnvelope !== undefined,
  );

function failure(request: Request, error: unknown, userId: string) {
  logRouteError(error, {
    category: "google_drive_settings_failure",
    ipAddress: getClientIpAddress(request.headers),
    message: "Unexpected failure while managing Google Drive.",
    path: getRequestPathname(request),
    userId,
  });

  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { headers: noStore, status: 500 },
  );
}

async function describe() {
  const connection = await getDriveConnection();
  const appUrl = resolveAppUrl();

  return {
    configured: getGoogleClient() !== null,
    connection: connection
      ? {
          accountEmail: connection.accountEmail,
          connectedAt: connection.connectedAt,
          folderId: connection.folderId,
          folderName: connection.folderName,
          lastUploadAt: connection.lastUploadAt,
          lastUploadError: connection.lastUploadError,
          subfolderPerEnvelope: connection.subfolderPerEnvelope,
        }
      : null,
    redirectUri: appUrl ? new URL(CALLBACK_PATH, appUrl).toString() : null,
  };
}

export async function GET(request: Request) {
  const session = await requireIntegrationAdmin(request, {
    rateLimited: false,
  });

  if (session instanceof Response) {
    return session;
  }

  try {
    return NextResponse.json(await describe(), { headers: noStore });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

export async function PATCH(request: Request) {
  const session = await requireIntegrationAdmin(request);

  if (session instanceof Response) {
    return session;
  }

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Nothing to change." },
      { headers: noStore, status: 400 },
    );
  }

  try {
    const connection = await getDriveConnection();

    if (!connection) {
      return NextResponse.json(
        { error: "Google Drive is not connected." },
        { headers: noStore, status: 409 },
      );
    }

    const { folderId, subfolderPerEnvelope } = parsed.data;

    if (folderId !== undefined) {
      const folder = await getFolder(
        await accessTokenForConnection(connection),
        folderId,
      );

      if (!folder) {
        return NextResponse.json(
          {
            error:
              "That folder cannot be used. It must be a folder this site made in the connected Drive, for example one from an earlier connection.",
          },
          { headers: noStore, status: 400 },
        );
      }

      await getDb().query(
        "UPDATE google_drive_connection SET folder_id = $1, folder_name = $2 WHERE id = 1",
        [folder.id, folder.name],
      );
      await recordAdminActivity({
        event: "google_drive_folder_changed",
        metadata: { folderId: folder.id, folderName: folder.name },
        request,
        user: session.user,
      });
    }

    if (subfolderPerEnvelope !== undefined) {
      await getDb().query(
        "UPDATE google_drive_connection SET subfolder_per_envelope = $1 WHERE id = 1",
        [subfolderPerEnvelope],
      );
    }

    return NextResponse.json(await describe(), { headers: noStore });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}

export async function DELETE(request: Request) {
  const session = await requireIntegrationAdmin(request);

  if (session instanceof Response) {
    return session;
  }

  try {
    const connection = await getDriveConnection();

    if (connection) {
      const token = decryptToken(connection.refreshTokenEncrypted);

      // Revoked first where possible, but a token Google no longer answers
      // for must not keep the connection here.
      if (token) {
        await revokeToken(token).catch(() => undefined);
      }

      await getDb().query("DELETE FROM google_drive_connection WHERE id = 1");
      await recordAdminActivity({
        event: "google_drive_disconnected",
        metadata: { folderId: connection.folderId },
        request,
        user: session.user,
      });
    }

    return NextResponse.json(await describe(), { headers: noStore });
  } catch (error) {
    return failure(request, error, session.user.id);
  }
}
