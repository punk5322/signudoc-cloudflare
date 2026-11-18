"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import type { WebhookEndpoint } from "@/lib/integrations/webhooks";

// Webhooks and Google Drive filing. Administrators only. How both work, and
// how a receiver checks a webhook's signature: docs/webhooks-and-drive.md.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

const EVENT_CHOICES = [
  ["sent", "Sent"],
  ["viewed", "Viewed"],
  ["signed", "Signed by a signer"],
  ["completed", "Completed"],
  ["declined", "Declined"],
  ["voided", "Voided"],
  ["expired", "Expired"],
] as const;

type EventName = (typeof EVENT_CHOICES)[number][0];

type DriveStatus = {
  configured: boolean;
  connection: {
    accountEmail: string | null;
    connectedAt: number;
    folderId: string;
    folderName: string | null;
    lastUploadAt: number | null;
    lastUploadError: string | null;
    subfolderPerEnvelope: boolean;
  } | null;
  redirectUri: string | null;
};

const DRIVE_OUTCOMES: Record<
  string,
  { text: string; tone: "error" | "success" }
> = {
  connected: { text: "Google Drive is connected.", tone: "success" },
  denied: { text: "Google Drive was not connected.", tone: "error" },
  failed: {
    text: "Connecting Google Drive failed. Please try again.",
    tone: "error",
  },
  no_refresh_token: {
    text: "Google did not grant offline access. Remove this site's access in your Google account, then connect again.",
    tone: "error",
  },
  not_configured: {
    text: "Google Drive is not set up on this site.",
    tone: "error",
  },
  state_mismatch: {
    text: "That sign-in did not start here, so it was ignored. Connect again from this page.",
    tone: "error",
  },
};

function formatTime(seconds: number | null): string {
  return seconds ? new Date(seconds * 1000).toLocaleString() : "never";
}

async function readJson<T>(
  response: Response,
): Promise<(T & { error?: string }) | null> {
  return (await response.json().catch(() => null)) as
    (T & { error?: string }) | null;
}

export function IntegrationsPanel() {
  return (
    <div
      className="space-y-8 border-t border-(--border) pt-8"
      id="integrations"
    >
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          Integrations
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Tell other systems when something happens to an envelope, and file
          finished envelopes in Google Drive. Both cover every envelope on this
          site.
        </p>
      </div>
      <WebhooksSection />
      <GoogleDriveSection />
    </div>
  );
}

function WebhooksSection() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<EventName[]>(["completed"]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    text: string;
    tone: "error" | "success";
  } | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/webhooks");
    const payload = await readJson<{ endpoints: WebhookEndpoint[] }>(response);

    if (!response.ok || !payload?.endpoints) {
      setMessage({
        text: payload?.error ?? GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
      return;
    }

    setEndpoints(payload.endpoints);
  }, []);

  useEffect(() => {
    // Through a promise, so no state is set while the effect itself runs.
    void Promise.resolve()
      .then(load)
      .catch(() => setMessage({ text: GENERIC_ERROR_MESSAGE, tone: "error" }));
  }, [load]);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setMessage(null);

    try {
      await action();
    } catch {
      setMessage({ text: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNewSecret(null);

    void run("add", async () => {
      const response = await fetch("/api/admin/webhooks", {
        body: JSON.stringify({ events, url: url.trim() }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJson<{ secret: string }>(response);

      if (!response.ok || !payload?.secret) {
        setMessage({
          text: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setUrl("");
      setNewSecret(payload.secret);
      await load();
    });
  }

  function sendTest(id: string) {
    void run(`test:${id}`, async () => {
      const response = await fetch(`/api/admin/webhooks/${id}`, {
        body: JSON.stringify({ action: "test" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJson<object>(response);

      if (!response.ok) {
        setMessage({
          text: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setMessage({ text: "Test event queued.", tone: "success" });
      // The delivery runs after the response; give it a moment to show.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await load();
    });
  }

  function remove(id: string) {
    if (
      !window.confirm("Remove this webhook? It stops receiving events at once.")
    ) {
      return;
    }

    void run(`remove:${id}`, async () => {
      const response = await fetch(`/api/admin/webhooks/${id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const payload = await readJson<object>(response);

        setMessage({
          text: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      await load();
    });
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h4 className="text-base font-bold text-(--fg)">Webhooks</h4>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Each event is sent as a signed JSON POST to an HTTPS address. Failed
          deliveries are retried for about two days.
        </p>
      </div>

      {message ? (
        <p
          className={`notice ${message.tone === "success" ? "notice-success" : "notice-danger"}`}
          role={message.tone === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}

      {newSecret ? (
        <div className="notice notice-success space-y-2" role="status">
          <p>
            Webhook added. Copy its signing secret now: it is not shown again.
            Receivers use it to check the X-Signature header.
          </p>
          <code className="block break-all text-sm select-all">
            {newSecret}
          </code>
        </div>
      ) : null}

      {endpoints?.length ? (
        <ul className="space-y-4">
          {endpoints.map((endpoint) => (
            <li
              className="space-y-3 rounded-lg border border-(--border) p-4"
              key={endpoint.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm font-semibold text-(--fg)">
                    {endpoint.url}
                  </p>
                  <p className="text-xs text-(--secondary)">
                    {endpoint.events.join(", ")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    className="btn-quiet"
                    disabled={busy !== null}
                    onClick={() => sendTest(endpoint.id)}
                    type="button"
                  >
                    {busy === `test:${endpoint.id}`
                      ? "Sending..."
                      : "Send test"}
                  </button>
                  <button
                    className="btn-quiet btn-quiet-danger"
                    disabled={busy !== null}
                    onClick={() => remove(endpoint.id)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </div>
              {endpoint.recentDeliveries.length ? (
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">Recent deliveries</caption>
                  <thead className="text-(--secondary)">
                    <tr>
                      <th className="py-1 pr-3 font-semibold">Event</th>
                      <th className="py-1 pr-3 font-semibold">Status</th>
                      <th className="py-1 pr-3 font-semibold">Tries</th>
                      <th className="py-1 font-semibold">Last try</th>
                    </tr>
                  </thead>
                  <tbody>
                    {endpoint.recentDeliveries.map((delivery) => (
                      <tr
                        className="border-t border-(--border)"
                        key={delivery.id}
                      >
                        <td className="py-1 pr-3">{delivery.event}</td>
                        <td className="py-1 pr-3">
                          <span
                            className={`pill ${
                              delivery.status === "delivered"
                                ? "pill-success"
                                : delivery.status === "failed"
                                  ? "pill-danger"
                                  : "pill-neutral"
                            }`}
                          >
                            {delivery.status === "pending" &&
                            delivery.attempts > 0
                              ? "retrying"
                              : delivery.status}
                          </span>
                          {delivery.lastError ? (
                            <span className="ml-2 text-(--secondary)">
                              {delivery.lastError}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-1 pr-3">{delivery.attempts}</td>
                        <td className="py-1">
                          {formatTime(delivery.lastAttemptAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-xs text-(--secondary)">No deliveries yet.</p>
              )}
            </li>
          ))}
        </ul>
      ) : endpoints ? (
        <p className="text-sm text-(--secondary)">No webhooks yet.</p>
      ) : null}

      <form className="space-y-4" noValidate onSubmit={add}>
        <FieldShell
          disabled={busy !== null}
          helper="HTTPS only. Private and internal addresses are refused."
          label="Endpoint URL"
          name="webhook-url"
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/hooks/signudoc"
          readOnly={false}
          value={url}
        />
        <fieldset className="space-y-2">
          <legend className="text-[0.8125rem] font-semibold text-(--secondary)">
            Events
          </legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {EVENT_CHOICES.map(([value, label]) => (
              <label
                className="flex items-center gap-2 text-sm text-(--fg)"
                key={value}
              >
                <input
                  checked={events.includes(value)}
                  onChange={(event) =>
                    setEvents((current) =>
                      event.target.checked
                        ? [...current, value]
                        : current.filter((item) => item !== value),
                    )
                  }
                  type="checkbox"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <ShellButton
          className="w-fit"
          disabled={!url.trim() || events.length === 0}
          loading={busy === "add"}
          type="submit"
        >
          {busy === "add" ? "Adding..." : "Add webhook"}
        </ShellButton>
      </form>
    </div>
  );
}

function GoogleDriveSection() {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [folderId, setFolderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    tone: "error" | "success";
  } | null>(null);

  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("drive");

    fetch("/api/admin/google-drive")
      .then(async (response) => {
        const payload = await readJson<DriveStatus>(response);

        // What happened at Google, from the callback's redirect.
        if (outcome && DRIVE_OUTCOMES[outcome]) {
          setMessage(DRIVE_OUTCOMES[outcome]);
        }

        if (response.ok && payload) {
          setStatus(payload);
        } else {
          setMessage({
            text: payload?.error ?? GENERIC_ERROR_MESSAGE,
            tone: "error",
          });
        }
      })
      .catch(() => setMessage({ text: GENERIC_ERROR_MESSAGE, tone: "error" }));
  }, []);

  async function change(method: "DELETE" | "PATCH", body?: object) {
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/google-drive", {
        body: body ? JSON.stringify(body) : undefined,
        headers: body ? { "content-type": "application/json" } : undefined,
        method,
      });
      const payload = await readJson<DriveStatus>(response);

      if (!response.ok || !payload) {
        setMessage({
          text: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setStatus(payload);
      setFolderId("");
    } catch {
      setMessage({ text: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const connection = status?.connection ?? null;

  return (
    <div className="space-y-5" id="google-drive">
      <div className="space-y-2">
        <h4 className="text-base font-bold text-(--fg)">Google Drive</h4>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          When an envelope is completed, its signed PDF and certificate are
          uploaded to a folder in Google Drive.
        </p>
      </div>

      {message ? (
        <p
          className={`notice ${message.tone === "success" ? "notice-success" : "notice-danger"}`}
          role={message.tone === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}

      {status && !status.configured && !connection ? (
        <div className="space-y-2 opacity-70" aria-disabled="true">
          <span className="pill pill-neutral">Not available</span>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            An administrator of the server must first create a Google OAuth
            client (type Web application) and set GOOGLE_CLIENT_ID and
            GOOGLE_CLIENT_SECRET.
            {status.redirectUri ? (
              <>
                {" "}
                Its authorized redirect URI is{" "}
                <code className="break-all">{status.redirectUri}</code>.
              </>
            ) : null}
          </p>
        </div>
      ) : null}

      {status?.configured && !connection ? (
        <a
          className="btn-quiet inline-flex w-fit"
          href="/api/admin/google-drive/connect"
        >
          Connect Google Drive
        </a>
      ) : null}

      {connection ? (
        <div className="space-y-4">
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-(--secondary)">Status</dt>
            <dd>
              <span className="pill pill-success">Connected</span>
              {connection.accountEmail
                ? ` as ${connection.accountEmail}`
                : null}
            </dd>
            <dt className="text-(--secondary)">Folder</dt>
            <dd className="break-all">
              {connection.folderName ?? "Untitled"} ({connection.folderId})
            </dd>
            <dt className="text-(--secondary)">Last upload</dt>
            <dd>{formatTime(connection.lastUploadAt)}</dd>
            {connection.lastUploadError ? (
              <>
                <dt className="text-(--secondary)">Last error</dt>
                <dd className="text-(--danger)">
                  {connection.lastUploadError}
                </dd>
              </>
            ) : null}
          </dl>

          <label className="flex items-center gap-2 text-sm text-(--fg)">
            <input
              checked={connection.subfolderPerEnvelope}
              disabled={busy}
              onChange={(event) =>
                void change("PATCH", {
                  subfolderPerEnvelope: event.target.checked,
                })
              }
              type="checkbox"
            />
            Put each envelope in a folder of its own
          </label>

          <form
            className="flex flex-wrap items-end gap-3"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void change("PATCH", { folderId: folderId.trim() });
            }}
          >
            <div className="min-w-64 flex-1">
              <FieldShell
                disabled={busy}
                helper="Optional. Must be a folder this site made in the connected Drive."
                label="Use another folder (folder ID)"
                name="drive-folder-id"
                onChange={(event) => setFolderId(event.target.value)}
                readOnly={false}
                value={folderId}
              />
            </div>
            <ShellButton
              className="w-fit"
              disabled={!folderId.trim()}
              loading={busy}
              type="submit"
            >
              Use folder
            </ShellButton>
          </form>

          <button
            className="btn-quiet btn-quiet-danger"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Disconnect Google Drive? Files already uploaded stay in Drive.",
                )
              ) {
                void change("DELETE");
              }
            }}
            type="button"
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
