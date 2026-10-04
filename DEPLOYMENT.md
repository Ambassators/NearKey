# Deploy NearKey to a new Vercel project

This prepares the website and its server for Vercel. The Android app stays installed
on your phone. The hosted website can reach it over Wi-Fi or cellular; Bluetooth
between the phone and computer is still required to finish sign-in.

## 1. Create the project and storage

1. Push this repository to your own GitHub repository and import it at
   [Vercel New Project](https://vercel.com/new). Select **Other** for the framework
   and the repository root as the root directory. The included `vercel.json`
   supplies the build, output and function settings. Use Node.js 24.x and keep
   Fluid compute enabled.
2. Pick a project name and note its stable production domain, such as
   `https://your-project.vercel.app`. This exact domain will be `PUBLIC_ORIGIN`.
3. Create a **Free** Redis database through Vercel's Upstash integration or
   [Upstash Console](https://console.upstash.com/). Use a database region near your
   Vercel function region. Copy the HTTPS REST URL and the **read-write** REST token.
   A read-only token cannot save pairings or sessions.
4. Add the following environment variables in Vercel's project settings for
   **Production**, then deploy or redeploy. Do not put the token in browser code
   or commit a filled-in `.env` file.

| Variable | Value |
| --- | --- |
| `PUBLIC_ORIGIN` | Your stable HTTPS production origin, with no trailing slash or path |
| `DEMO_USERNAME` | Your chosen demo username |
| `DEMO_PASSWORD` | A new random password of 16–256 characters; the local sample password is rejected |
| `UPSTASH_REDIS_REST_URL` | Upstash's HTTPS REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash's read-write REST token |
| `NEARKEY_STATE_KEY` | `nearkey:production:v1` |

`.env.example` lists the variables. Hosted startup requires every credential and
never falls back to local memory or the local pairing file. You can set up the
project before the variables are ready, but that deployment will remain unusable
until you add them and redeploy.

Use the stable production URL for pairing and sign-in. Preview deployment domains
will not match `PUBLIC_ORIGIN`. For a separate preview environment, use its own
fixed domain and a different `NEARKEY_STATE_KEY` or database. Never share the
production key with another username or domain.

## 2. Verify the deployment

1. Open the production URL in Chrome on the computer. Log in with your new
   username/password. The account must remain locked pending phone verification.
2. Scan the new setup QR in the Android app and enroll. The local `.data/phone.json`
   is not uploaded or imported, so the hosted account needs this first enrollment.
3. Keep the phone online and complete the nearby Bluetooth step. Check that the
   dashboard opens and an app entry can be saved.
4. Refresh the page, log out and log in again. Bluetooth verification is required
   for each new login.
5. Redeploy the same project without changing the domain or state key. The phone,
   unexpired sessions, apps and history should remain saved. Keep the phone app
   open during a test lasting more than five minutes to check its reconnection.

Vercel [supports WebSockets in beta on all plans](https://vercel.com/docs/functions/websockets).
The function exports the existing HTTP server and handles both browser requests
and native phone upgrades. Connections rotate before the configured five-minute
function deadline; the phone reconnects and receives any pending challenge.
The setup page can briefly refresh its QR when its connection rotates.

If phone requests return a Vercel login page, review Deployment Protection for the
production domain: the native Android app cannot log into a Vercel-protected preview.
An origin error means the browser URL does not match `PUBLIC_ORIGIN`; a storage
error means to check the Redis URL, read-write token and database availability.

## Shared state and limits

The local `npm start` and `npm run start:wifi` workflows keep their existing behavior.
On Vercel, Redis stores the enrolled public key and phone credential, browser
sessions, temporary pairing codes, pending challenges, saved apps and history.
The Android private key stays in AndroidKeyStore.

A fenced Redis lease serializes this single demo account across server instances.
API replies and phone messages are released after the shared state commits. An
expired lease or storage failure returns an unavailable response rather than
opening the dashboard or acknowledging an unsaved pairing. A dead server's phone
presence and page QR expire after about 20 seconds. Phone challenge messages are
relayed through a bounded shared queue, polled every two seconds while a local
socket is connected; reconnecting replays the current pending challenge.

This is a small demo, with one account and one enrolled phone, rather than a
multi-user authentication service. API and credential limits are shared across the
account. Polling consumes Redis commands and Vercel compute while connected, so
free tiers suit short demos; check [Upstash's current free limits](https://upstash.com/pricing/redis)
and [Vercel Hobby limits](https://vercel.com/docs/plans/hobby) before leaving it
connected continuously. No paid plan or account has been created by this change.

To rotate the username, password or origin and revoke all sessions, deploy with a
new `NEARKEY_STATE_KEY` and enroll the phone again. Ordinary code deployments should
keep the same key. Removing the old Redis state also removes the enrolled phone;
only do that as an intentional account reset. The local browser-only reset API is
disabled for HTTPS hosted origins.

## What is checked locally

`npm test` includes cross-instance HTTP/WebSocket login with real P-256 signatures,
restart persistence, concurrent proof consumption, phone reconnection, page-bound
pairing, and storage outage/lease-failure checks. These tests use a shared fake
Upstash REST service; the live Vercel build, real Redis service, Android cellular
connection and browser Bluetooth require the deployment checks above.
