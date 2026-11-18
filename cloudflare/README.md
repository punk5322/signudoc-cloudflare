# SignuDoc on Cloudflare

This folder runs [SignuDoc](https://github.com/NYLLON-SOFTWARE/SignuDoc) on Cloudflare instead of Vercel. The app is the same Next.js server in a [Cloudflare Container](https://developers.cloudflare.com/containers/). Documents are kept in an [R2](https://developers.cloudflare.com/r2/) bucket, and email goes out through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/). The database is Postgres, from any provider.

The Cloudflare version is by [Jonathan Drake (@drake)](https://github.com/drake). It is an independent fork under the same MIT license, and SignuDoc's authors do not run it. Report problems with it in [this repository's issues](https://github.com/drake/signudoc-cloudflare/issues), not theirs.

| Part           | On Vercel       | Here                                               |
| -------------- | --------------- | -------------------------------------------------- |
| The app        | Vercel Function | A container, started by the Worker in `worker.mjs` |
| Documents      | Vercel Blob     | An R2 bucket bound to the Worker                   |
| Email          | Resend          | Cloudflare Email Service, bound to the Worker      |
| Daily cleanup  | Vercel cron     | A cron trigger on the Worker                       |
| Database       | Neon Postgres   | Any Postgres, for example Neon                     |
| Bot protection | Vercel BotID    | Not available. The rate limits still apply.        |

## What you bring

One thing: a Postgres database. Cloudflare has none to create for you. [Neon](https://neon.com)'s free plan is enough. Everything else is made on your Cloudflare account by the deployment: the Worker, the container, the bucket and the connection to email.

You also need:

- a Cloudflare account on the Workers Paid plan, because Containers and Email Sending are not on the free plan;
- a domain on that account with Email Sending turned on, before the site can send email.

No API tokens or access keys are needed. The app asks the Worker for its documents and its email, and the Worker uses its own bindings (see `worker.mjs`). The Worker makes a token for each install, gives it to the app when the container starts, and answers only requests for documents or email that carry it.

## Set it up

The quickest way is the **Deploy to Cloudflare** button in the [README](../README.md). It copies this repository into your GitHub account, creates the Worker, the container and the bucket on your Cloudflare account, and asks for one value, the database connection string from step 1 below. Leave its build command empty. Then carry on from step 4. [Deploying to Cloudflare with an agent](../docs/deploy-to-cloudflare-with-an-agent.md) walks through every screen.

To do it by hand instead:

1. **Create the database.** In Neon, create a project and copy its connection string with connection pooling turned off.
2. **Store it.** From the top of the repository, run `npx wrangler secret put DATABASE_URL` and paste the connection string.
3. **Deploy.** Run `npx wrangler r2 bucket create signudoc-documents` once, to make the bucket. Then start Docker (or [Colima](https://github.com/abiosoft/colima)) and run `npx wrangler deploy`. The first deployment takes a few minutes.
4. **Open the site** at the `workers.dev` address the deployment prints. It takes you to `/setup`, as in [Self-hosting](../docs/self-hosting.md#set-the-site-up). Do this straight away: a new install belongs to whoever sets it up first.
5. **Turn on email.** Run `npx wrangler email sending enable <your domain>`, or turn on Email Sending for the domain in the Cloudflare dashboard. Then, under Settings, Organization, enter an address at that domain in "Send email from", save, and send yourself a test email there. When it arrives, the page shows email as working.

The database tables are created, and later updated, each time the container starts.

### Deploying from GitHub

`.github/workflows/deploy-cloudflare.yml` deploys every push to `main` that passes CI. It needs two secrets on the GitHub repository: `CLOUDFLARE_API_TOKEN`, a token that may edit Workers and Containers, and `CLOUDFLARE_ACCOUNT_ID`. Until the token is set, the workflow passes without deploying anything.

### Settings

Every variable and secret on the Worker reaches the app as an environment variable, so any setting in [`.env.example`](../.env.example) can be set with `npx wrangler secret put <NAME>`. Four are worth knowing:

| Setting                | What it does                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`              | The site's public address. Unset, it is the address the site was first opened at. Set it when you move the site to a domain of your own. |
| `SETUP_TOKEN`          | A secret the first-run setup page asks for.                                                                                              |
| `RETENTION_JOB_SECRET` | Closes the daily cleanup route to everyone but the Worker.                                                                               |
| `ANTHROPIC_API_KEY`    | Turns on "Place fields with AI" when preparing an envelope. The draft's PDF is sent to Anthropic's API. Unset, the button is disabled.   |

### A domain of your own

The site starts at its `workers.dev` address. To move it to a domain on your Cloudflare account:

1. Run `npx wrangler secret put APP_URL` and enter the new address, such as `https://sign.example.com`.
2. Deploy with `npx wrangler deploy --domain sign.example.com`.

The app restarts by itself to take the new address, within about a minute of the deployment. Sign in again at the new address afterwards. Links in emails sent before the move still point to the old address.

## What is different from SignuDoc itself

Nearly everything for Cloudflare is in new files: this folder, `wrangler.jsonc` and `.dev.vars.example` at the top of the repository, `.dockerignore`, `.github/workflows/deploy-cloudflare.yml`, the storage driver in `src/lib/services/storage/s3.ts` and the email driver in `src/lib/services/email-cloudflare.ts`, each with its test.

Eight of SignuDoc's own files have a few added lines. `README.md` has the Cloudflare button, `SECURITY.md` says where to report a problem in the Cloudflare parts, and `.gitignore` has two entries for Wrangler. The other five have theirs so that the two drivers can be chosen and Settings can describe Cloudflare email:

- `src/lib/services/storage.ts` and `src/lib/services/storage/driver.ts`, for `STORAGE_DRIVER=s3`
- `src/lib/services/email.ts`, `src/lib/email-status.ts` and `src/components/settings/organization-settings.tsx`, for `EMAIL_DRIVER=cloudflare`

Nothing else is changed, which is what lets most new SignuDoc releases merge in cleanly.

Both drivers also work away from Cloudflare. `STORAGE_DRIVER=s3` takes any S3-compatible store through `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. `EMAIL_DRIVER=cloudflare` sends through Cloudflare's REST API with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_EMAIL_API_TOKEN`.

## Things to know

- **The container sleeps** after 15 minutes without a visitor. The next request waits about ten seconds for it to start, which includes the Next.js server and a check for database changes.
- **One container serves the install.** That suits an organization. A busy public service would need more than one, and a change to `worker.mjs`.
- **Uploads go through the app**, not straight to the bucket as on Vercel. Cloudflare accepts request bodies well above SignuDoc's upload limit.
- **Email differs from Resend in three ways.** Cloudflare has no shared test address, so nothing is sent until "Send email from" is set. One email, attachments included, can be 25 MiB at most, so a very large signed PDF may fail to send as an attachment. And a send that is retried after a lost answer can arrive twice, because Cloudflare has no idempotency key.
- **Some labels still say Resend.** The setup page and a few lines in Settings are left as SignuDoc wrote them.
- **Back up the bucket.** Finished documents exist only there.

## Updates

SignuDoc's own update workflow, `.github/workflows/update-signudoc.yml`, works here as it does on any copy: every Monday it merges the latest release into a branch and opens a pull request. Merging it runs CI, and a pass deploys it. Where the pull request says "Vercel builds a preview", there is no preview here: CI is the check.

An update stops and asks for help only when a release changes the same lines this copy changed, which are the few in the eight files above.
