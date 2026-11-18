import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import { BUCKET_PLACEHOLDER, sendEmail, serveStorage } from "./gateways.mjs";

// Runs SignuDoc on Cloudflare. The app itself is the Next.js server in a
// container (see ./Dockerfile). This Worker is the front door: it starts
// the container when a request arrives, passes every request to it, and
// calls the daily cleanup on a schedule.
//
// It also gives the app its documents and its email without any Cloudflare
// keys. The app asks for both over plain HTTP at two names that exist only
// inside the container. Requests to those names never leave Cloudflare:
// they are handed to the two gateways below, which use this Worker's own R2
// bucket and email binding.
//
// The gateways answer only a request that carries this install's gateway
// token (see ./gateways.mjs). The token is made here and given to the app
// when its container starts, so a request the app is tricked into making to
// one of those names is refused.
//
// Plain JavaScript, so the app's own typecheck leaves it alone.

const PORT = 8080;
// The container sleeps after this long without a request. The next visitor
// then waits for it to start again.
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
// Starting covers the database migrations and the Next.js server.
const STARTUP_ATTEMPTS = 300;
// One container serves the whole install.
const INSTANCE_NAME = "app";

const STORAGE_HOST = "storage.signudoc.internal";
const EMAIL_HOST = "email.signudoc.internal";

/** The app's document storage, on this Worker's R2 bucket. */
export class StorageGateway extends WorkerEntrypoint {
  fetch(request) {
    return serveStorage(request, this.env.DOCUMENTS, this.ctx.props?.token);
  }
}

/** The app's outgoing email, on this Worker's email binding. */
export class EmailGateway extends WorkerEntrypoint {
  fetch(request) {
    return sendEmail(request, this.env.EMAIL, this.ctx.props?.token);
  }
}

/** A short stand-in for a set of settings, safe to keep: it reveals none. */
async function fingerprintOf(settings) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(Object.entries(settings).sort())),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class SignuDocApp extends DurableObject {
  starting;
  monitoring;
  /** The settings the running container was last seen answering with. */
  ready;

  constructor(ctx, env) {
    super(ctx, env);

    const container = ctx.container;

    if (container?.running) {
      // Restore the timeout and exit monitoring after a restart of this
      // object while its container kept running.
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
      this.observeExit();
    }
  }

  async fetch(request) {
    // The public address the site was first reached at. The app needs it
    // for the links in its emails, and the daily cleanup starts the
    // container without a visitor to take it from.
    const publicOrigin = request.headers.get("x-signudoc-origin");

    if (publicOrigin && !(await this.ctx.storage.get("appUrl"))) {
      await this.ctx.storage.put("appUrl", publicOrigin);
    }

    if (!this.env.APP_URL && !(await this.ctx.storage.get("appUrl"))) {
      // Nobody has opened the site yet, so there is nothing to clean up
      // and no address to start the app with.
      return new Response(null, { status: 204 });
    }

    // Share startup across concurrent requests, including after a failed
    // attempt.
    this.starting ??= this.startAndWaitForPort().finally(() => {
      this.starting = undefined;
    });
    await this.starting;

    const url = new URL(request.url);

    url.protocol = "http:";
    url.host = "container";

    const forwarded = new Request(url, request);

    forwarded.headers.delete("host");
    forwarded.headers.delete("x-signudoc-origin");

    return this.ctx.container.getTcpPort(PORT).fetch(forwarded);
  }

  /** A secret made once for this install and kept with this object. */
  async storedSecret(name) {
    let secret = await this.ctx.storage.get(name);

    if (!secret) {
      secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      await this.ctx.storage.put(name, secret);
    }

    return secret;
  }

  /** What the app must present to the two gateways. */
  gatewayToken() {
    return this.storedSecret("gatewayToken");
  }

  /** The environment the app is started with. */
  async containerEnv() {
    const gatewayToken = await this.gatewayToken();

    return {
      // The deployed version, so a deploy (a new image) restarts the app.
      APP_BUILD: this.env.CF_VERSION_METADATA?.id ?? "",
      // The address the site was first opened at. Set APP_URL on the
      // Worker to use another, such as a domain of your own.
      APP_URL: (await this.ctx.storage.get("appUrl")) ?? "",
      // Signs sessions.
      BETTER_AUTH_SECRET: await this.storedSecret("authSecret"),
      // Documents and email through the gateways above. Both drivers send
      // the gateway token with every request: the email driver as its API
      // token, the storage driver as its access key id.
      CLOUDFLARE_ACCOUNT_ID: "internal",
      CLOUDFLARE_EMAIL_API_TOKEN: gatewayToken,
      CLOUDFLARE_EMAIL_API_URL: `http://${EMAIL_HOST}/send`,
      EMAIL_DRIVER: "cloudflare",
      S3_ACCESS_KEY_ID: gatewayToken,
      S3_BUCKET: BUCKET_PLACEHOLDER,
      S3_ENDPOINT: `http://${STORAGE_HOST}`,
      // The driver needs one to sign with. The gateway does not check the
      // signature, only the token.
      S3_SECRET_ACCESS_KEY: gatewayToken,
      STORAGE_DRIVER: "s3",
      // Every setting and secret of this Worker, which win over the
      // defaults above. A setting SignuDoc adds later works without a
      // change here.
      ...Object.fromEntries(
        Object.entries(this.env).filter(
          ([, value]) => typeof value === "string",
        ),
      ),
    };
  }

  async startAndWaitForPort() {
    const container = this.ctx.container;
    const env = await this.containerEnv();
    const fingerprint = await fingerprintOf(env);

    // Already checked, with these settings, since this object woke up.
    if (container.running && this.ready === fingerprint) {
      return;
    }

    // A container keeps the settings it was started with. When one has
    // changed since, such as APP_URL after a move to a new domain, the
    // container is stopped here and started again below.
    if (
      container.running &&
      (await this.ctx.storage.get("startedWith")) !== fingerprint
    ) {
      console.log("A setting changed. Restarting the SignuDoc container.");
      await container.destroy("A setting changed.");
    }

    if (!container.running) {
      // Intercepts last until the container stops, so they are set at
      // every start. Each gateway is told the token to ask for.
      const props = { token: await this.gatewayToken() };

      await container.interceptOutboundHttp(
        STORAGE_HOST,
        this.ctx.exports.StorageGateway({ props }),
      );
      await container.interceptOutboundHttp(
        EMAIL_HOST,
        this.ctx.exports.EmailGateway({ props }),
      );

      console.log(`Starting the SignuDoc container for ${env.APP_URL}.`);
      container.start({
        // The database is reached over the Internet.
        enableInternet: true,
        env,
        image: container.images.app,
        instance: "basic",
      });
      await this.ctx.storage.put("startedWith", fingerprint);
    }

    this.observeExit();
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    // "running" means startup was asked for, not that the server answers.
    const port = container.getTcpPort(PORT);

    for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt++) {
      try {
        const response = await port.fetch("http://container/", {
          redirect: "manual",
          signal: AbortSignal.timeout(1000),
        });

        // Any answer at all means the server is up.
        await response.body?.cancel();
        this.ready = fingerprint;

        return;
      } catch {
        // Not listening yet.
      }

      await scheduler.wait(200);
    }

    throw new Error(`SignuDoc did not start listening on port ${PORT}.`);
  }

  observeExit() {
    if (this.monitoring) {
      return;
    }

    this.monitoring = this.ctx.container
      .monitor()
      .then(() => console.log("SignuDoc container stopped."))
      .catch((error) => console.error("SignuDoc container failed:", error))
      .finally(() => {
        this.monitoring = undefined;
      });
    this.ctx.waitUntil(this.monitoring);
  }
}

const worker = {
  async fetch(request, env) {
    const forwarded = new Request(request);
    const url = new URL(request.url);

    // The visitor's address as Cloudflare saw it, replacing whatever the
    // visitor sent under the same name. SignuDoc's rate limits count by it.
    forwarded.headers.set(
      "x-forwarded-for",
      request.headers.get("cf-connecting-ip") ?? "",
    );
    forwarded.headers.set("x-forwarded-host", url.host);
    forwarded.headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
    forwarded.headers.set("x-signudoc-origin", url.origin);

    return env.APP.getByName(INSTANCE_NAME).fetch(forwarded);
  },

  // The daily cleanup, in place of the cron job in vercel.json. The schedule
  // is in wrangler.jsonc.
  async scheduled(_controller, env) {
    const secret = env.RETENTION_JOB_SECRET || env.CRON_SECRET;
    const response = await env.APP.getByName(INSTANCE_NAME).fetch(
      "https://signudoc/api/internal/retention",
      {
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
        method: "POST",
      },
    );

    await response.body?.cancel();

    if (!response.ok) {
      throw new Error(`The daily cleanup answered ${response.status}.`);
    }
  },
};

export default worker;
