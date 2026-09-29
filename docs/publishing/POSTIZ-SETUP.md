# Posting clips from Aksharo through Postiz — owner setup

Aksharo posts a run's clips to Instagram, YouTube, LinkedIn, X, Facebook,
Threads and TikTok (2026-09-29, `apps/api/src/publishing`). It does not talk to
those platforms itself: **Postiz** — the open-source social scheduler already
running on this laptop — holds each account's sign-in and does the posting.
Aksharo keeps one Postiz API key and never sees a social account's password or
token (ADR 0002 §3).

Everything below is done once, by the owner. Nothing in it is done by the
Aksharo code, and none of it touches the Aksharo production stack except the
last step (an env var and an API restart).

---

## 0. What is running today

| Container | What | Address |
|---|---|---|
| `postiz` | Postiz (frontend + API, `ghcr.io/gitroomhq/postiz-app:latest`) | `http://localhost:4007`, API under `/api` |
| `postiz-postgres`, `postiz-redis` | its database and cache | internal |

Its `FRONTEND_URL` is `http://localhost:4007`.

**It was not healthy when this was written (2026-09-29):** an unauthenticated
`GET http://127.0.0.1:4007/api/public/v1/is-connected` answered **502 Bad
Gateway** from the container's own nginx, and the front page did not answer
within 8 s — the Postiz backend behind it was not running. `docker logs postiz`
says why; a missing Temporal (next paragraph) is the usual reason with a
current image. Aksharo reports this as "The publishing service is not
answering".

**Check that Postiz's Temporal services run too.** Current Postiz releases send
and schedule posts through Temporal; the official compose file runs
`temporal`, `temporal-postgresql` and `temporal-elasticsearch` next to Postiz
(`TEMPORAL_ADDRESS: temporal:7233`). The snapshot of this laptop's containers
from 2026-09-29 lists no Temporal container. Without it, Postiz accepts a post
and it never goes out: Aksharo then shows it as "Posting…" (or scheduled) and,
after two hours, "It has not gone out yet". `docker ps` should list the
`temporal` containers; if not, bring Postiz up from the official compose file
(https://docs.postiz.com/self-host/installation/docker-compose).

## 1. Give Postiz a public HTTPS address (required)

Postiz stores an uploaded video under `FRONTEND_URL/uploads/...`, and the
platforms fetch it from there: Instagram, Facebook, Threads and TikTok pull the
file by URL, and Postiz's YouTube upload reads it by URL too. `localhost` is
reachable by none of them, so **no post goes out while `FRONTEND_URL` is
`http://localhost:4007`**. Several platforms also refuse an OAuth redirect that
is not HTTPS (TikTok, Threads, Meta in live mode). Postiz's own docs:
https://docs.postiz.com/self-host/configuration/uploads ("your local `/uploads`
path must therefore be reachable from the public internet over HTTPS").

Use the Cloudflare tunnel that already serves Aksharo:

1. Add an ingress rule to `~/.cloudflared/config.yml`, above the catch-all:
   ```yaml
   - hostname: postiz.crestmondtechnologies.com
     service: http://127.0.0.1:4007
   ```
2. Route the hostname to the tunnel:
   `cloudflared tunnel route dns <tunnel-name> postiz.crestmondtechnologies.com`
3. Restart the tunnel (a few seconds' blip for the live site too — do it at a
   quiet time).
4. Point Postiz at it. In its compose file:
   ```yaml
   MAIN_URL: 'https://postiz.crestmondtechnologies.com'
   FRONTEND_URL: 'https://postiz.crestmondtechnologies.com'
   NEXT_PUBLIC_BACKEND_URL: 'https://postiz.crestmondtechnologies.com/api'
   ```
   and recreate the container: `docker compose down` then `docker compose up -d`
   ("when you change variables, you must run `docker compose down` and then
   `docker compose up`" — https://docs.postiz.com/self-host/installation/docker-compose).
5. Once your own Postiz account exists, set `DISABLE_REGISTRATION: 'true'`: the
   sign-up page is now on the public internet.

Alternative: Postiz can store uploads in Cloudflare R2 (`STORAGE_PROVIDER:
cloudflare`), which gives public HTTPS file URLs by itself
(https://docs.postiz.com/self-host/configuration/r2). The OAuth redirects still
need an HTTPS `FRONTEND_URL`.

Below, `{FRONTEND_URL}` means `https://postiz.crestmondtechnologies.com`.
Postiz builds every redirect as `{FRONTEND_URL}/integrations/social/<provider>`
(checked in its provider code, `redirect_uri: ${FRONTEND_URL}/integrations/social/...`).

## 2. One developer app per platform

Each platform only lets an app post if you register one with it. Put each
app's credentials in the Postiz container's environment, then recreate the
container once at the end. Provider guides:
https://docs.postiz.com/self-host/providers/overview

| Platform | Where | Redirect URI to register | Postiz env vars |
|---|---|---|---|
| YouTube | Google Cloud console | `{FRONTEND_URL}/integrations/social/youtube` | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` |
| Instagram + Facebook | one Meta app | `{FRONTEND_URL}/integrations/social/instagram` and `.../facebook` | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| Instagram (standalone, optional) | same Meta app, Instagram product | `{FRONTEND_URL}/integrations/social/instagram-standalone` | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` |
| Threads | Meta app with the Threads use case | `{FRONTEND_URL}/integrations/social/threads` | `THREADS_APP_ID`, `THREADS_APP_SECRET` |
| LinkedIn | LinkedIn developer app | `{FRONTEND_URL}/integrations/social/linkedin` and `.../linkedin-page` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| X | X developer portal | `{FRONTEND_URL}/integrations/social/x` | `X_API_KEY`, `X_API_SECRET` |
| TikTok | TikTok for Developers | `{FRONTEND_URL}/integrations/social/tiktok` | `TIKTOK_CLIENT_ID`, `TIKTOK_CLIENT_SECRET` |

**YouTube** (https://docs.postiz.com/self-host/providers/youtube). Create a
Google Cloud project; enable **YouTube Data API v3** (Postiz also asks for the
YouTube Analytics and YouTube Reporting APIs); set up the OAuth consent screen
(External) and add yourself as a test user; create an OAuth client ID of type
**Web application** with the redirect URI above. Google locks videos uploaded
by an unverified API project to **private** until the project passes Google's
API audit — Aksharo's "Everyone" will show as private on YouTube until then.

**Instagram and Facebook** (https://docs.postiz.com/self-host/providers/facebook,
https://docs.postiz.com/self-host/providers/instagram). One Meta app serves
both: create it under your business portfolio (use case "Other", type
Business), add **Facebook Login for Business**, register both redirect URIs,
and request `pages_show_list`, `business_management`, `pages_manage_posts`,
`pages_manage_engagement`, `pages_read_engagement`, `read_insights`,
`instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`,
`instagram_manage_insights`. The Instagram account must be a professional
account linked to a Facebook Page. **Switch the app to Live mode**, or posts
are visible only to you.

**Threads** (https://docs.postiz.com/self-host/providers/threads). Add the
Threads use case with `threads_basic` and `threads_content_publish`, register
the redirect URI (click it after typing it, or the form does not save), add
your Threads account under App roles as a tester and accept the invitation in
the Threads app.

**LinkedIn** (https://docs.postiz.com/self-host/providers/linkedin). Create the
app, add the products **Share on LinkedIn**, **Sign In with LinkedIn using
OpenID Connect** and **Advertising API** (Postiz needs the last for token
refresh), and check the scopes `openid`, `profile`, `w_member_social`,
`r_basicprofile`, `rw_organization_admin`, `w_organization_social`,
`r_organization_social`.

**X** (https://docs.postiz.com/self-host/providers/x-twitter). In the app's
user authentication settings choose **Read and write** and app type **Native
App** (other types fail with error 32), add the callback URI, then copy the
consumer **API Key and Secret**. Posting a video needs an X API access level
that includes media upload.

**TikTok** (https://docs.postiz.com/self-host/providers/tiktok). Register a
Web app with terms and privacy URLs on an HTTPS domain you own, add **Login
Kit** and **Content Posting API** with Direct Post, the scopes
`user.info.basic`, `video.create`, `video.publish`, `video.upload`,
`user.info.profile`, and verify the domain the videos come from (the Postiz
hostname). Until TikTok audits the app, it posts **private only**, for at most
five users a day — Aksharo's TikTok visibility starts at "Only me" for that
reason. TikTok also has its own Aksharo flag (`publishing_tiktok`), off until
you switch it on.

## 3. Connect the accounts in Postiz

Open `{FRONTEND_URL}`, sign in, and use **Add Channel** for each account
(https://docs.postiz.com/general/channels/connect). Aksharo lists whatever is
connected here; it cannot connect an account itself.

## 4. Create the Public API key

In Postiz: **Settings → Developers**, the Public API key
(https://docs.postiz.com/general/settings/developers). Keys do not expire; if
one leaks, rotate it there and update Aksharo.

Postiz limits post creation through this API to `API_LIMIT` an hour (90 by
default; the compose file sets **30**). Aksharo waits a limit out rather than
failing, but "Post one a day" for 20 clips on 3 accounts is 60 posts: raise
`API_LIMIT` on the Postiz container if you schedule in bulk.

## 5. Tell Aksharo

Add to the API's environment — on this machine `.env.local-run`, which is a
**hard link** shared with the release worktree: edit it in place, never write a
new file over it (CLAUDE.md §1).

```ini
# The Public API key from step 4.
POSTIZ_API_KEY=...
# Where the API reaches Postiz. The default is right on this machine, even
# after step 1: the API calls Postiz locally, not through the tunnel.
POSTIZ_API_URL=http://127.0.0.1:4007/api
# The link Settings → Publishing shows. Default http://localhost:4007.
POSTIZ_APP_URL=https://postiz.crestmondtechnologies.com
# The Aksharo workspaces allowed to post through this Postiz: the accounts in
# it are yours, so only your workspace. Nobody else posts, whatever the flag says.
POSTIZ_WORKSPACE_IDS=01M1KFX35NJRD5N58H0J6YGAPC
```

`POSTIZ_API_URL` must be HTTPS unless it points at this machine
(`localhost` / `127.0.0.1`): the key would otherwise cross a network in clear.
`PUBLISH_WORKER_ENABLED=0` stops the API from sending (the page still works).

Then switch on the feature flag for your workspace — `publishing_postiz`
(seeded off), targeted at the workspace id, the same way `repurpose_flow` is —
and restart the API. Do not switch it on globally, and never through
`FEATURE_FLAGS_JSON` (that turns it on for everyone; `POSTIZ_WORKSPACE_IDS`
still stops them posting, but they would see the button).

## 6. Check

- Aksharo, **Settings → Publishing** (`/settings/publishing`): "Ready. N
  accounts can be posted to", with the accounts listed. Otherwise it says
  which step is missing.
- On a run, each finished clip has **Post**: pick accounts (each shows the
  video shape it will get — Reels, Shorts, TikTok and Threads 9:16; Facebook
  4:5; LinkedIn and X square), edit the text per platform, then **Now**, **Pick
  a time**, or **One a day** (7 pm India time on the next day that account has
  nothing posted). **Post one a day** above the clips does the same for many
  clips at once.
- Each clip lists its posts: scheduled for when, posted with a link, or not
  posted with the reason and **Try again**. A scheduled post can be cancelled
  until it goes out.

## How it behaves (for support)

- Postiz is the scheduler: a scheduled post is handed to Postiz, with its video
  and text, when you confirm. Moving or deleting it in Postiz's calendar is
  mirrored in Aksharo on its next check.
- Aksharo checks each post until it is out: every 30 s rising to every 10 min
  while it is going out, once a day while it waits, right after its time.
  After two hours of "going out" it stops and asks you to look in Postiz.
- A post whose answer was lost is never sent twice: Aksharo looks for it in
  Postiz first (same account, same words, same time) and only sends again when
  it is not there after about eight minutes.
- Only a finished captioned video is posted — never the clean cut, and never
  one whose captions were edited after it was made.

## Troubleshooting

| Aksharo says | Likely cause |
|---|---|
| Posting is not set up yet | `POSTIZ_API_KEY` missing, or the API was not restarted |
| Posting is set up for another workspace | this workspace is not in `POSTIZ_WORKSPACE_IDS` |
| The publishing service refused Aksharo's key | the key was rotated in Postiz; update `POSTIZ_API_KEY` |
| The publishing service is not answering | the `postiz` container is down, or `POSTIZ_API_URL` is wrong |
| No accounts are connected yet | step 3 |
| It has not gone out yet | Temporal is not running (step 0), or the platform is slow |
| … did not take the post | Postiz shows the platform's reason on the post; often an expired connection (reconnect the channel) or an app still in development mode |

## Sources

- Public API: https://docs.postiz.com/public-api/introduction,
  https://docs.postiz.com/public-api/posts/create,
  https://docs.postiz.com/public-api/posts/list,
  https://docs.postiz.com/public-api/posts/delete,
  https://docs.postiz.com/public-api/uploads/upload-file,
  https://docs.postiz.com/public-api/integrations/list
- Configuration: https://docs.postiz.com/self-host/configuration/reference,
  https://docs.postiz.com/self-host/configuration/uploads,
  https://docs.postiz.com/self-host/installation/docker-compose
- Providers: https://docs.postiz.com/self-host/providers/youtube, …/facebook,
  …/instagram, …/threads, …/linkedin, …/x-twitter, …/tiktok
- Checked against the Postiz v1.47 source in `postiz-app-main/` (public API
  controller, post DTOs, provider redirect URIs).
