# VL Funnel — Deployment & Testing Guide

This folder contains the WordPress-side "service window" for the Cloudflare-hosted signup pages. The landing pages are fully decoupled from WordPress — they call a REST endpoint to register the user, then send them to a one-time auto-login URL. The user lands on the OTO page already logged in, with their initial password shown once via a shortcode.

**Covers:** `/smm-free-course/`, `/free-course/a/`, `/free-course/b/`, and any future funnel wired to `VL_CONFIG` + `POST /api/register`.

**Architecture:**

```
Visitor → go.urbansketchcourse.com/<funnel>/   (Cloudflare Pages, static HTML + modal signup)
         │
         │  POST /api/register   (SAME-ORIGIN — handled by _worker.js)
         ▼
         Cloudflare Worker (_worker.js)
         │   └─ forwards server-to-server to learn.urbansketch.com
         ▼
         learn.urbansketch.com/wp-json/vl/v1/register  (WordPress + LearnDash + AffiliateWP + this MU-plugin)
         │   ├─ verifies Turnstile (token only — NO remoteip)
         │   ├─ rate-limits by IP
         │   ├─ creates user + enrols in LearnDash course
         │   ├─ credits AffiliateWP referral (from affiliate_id in POST body)
         │   ├─ stores initial password in user meta (15-min TTL)
         │   ├─ suppresses wp_mail() during user creation (broken SMTP)
         │   └─ returns one-time auto-login URL
         │
         │  redirect → /vl-auto-login?t=TOKEN&r=/smm/free-course-oto-1-smm/
         ▼
         User lands logged-in on the OTO page.
         [vl_credentials] shortcode on that page shows their password once.
```

Why the same-origin proxy: direct browser → WP POSTs were failing because the host was stripping `Access-Control-Allow-Origin` on POST responses (OPTIONS preflight was fine). Routing through the Worker makes the browser see a same-origin request and sidesteps CORS entirely.

Why no `remoteip` in Turnstile verification: the Worker proxy means WP sees the Worker's IP, not the user's. Including that as `remoteip` caused Turnstile to reject every valid browser token. The signed token alone is proof.

Slug changes, theme changes, and plugin updates can't break this — everything runs through the MU-plugin, and MU-plugins don't auto-update.

---

## 1. Fill in the config constants (5 minutes)

> **Current production values are already in `vl-funnel.php`:**
> `VL_FUNNEL_FREE_COURSE_ID = 39746`, `VL_FUNNEL_TURNSTILE_SECRET` set, redirect + prefixes set.
> If you're redeploying fresh or forking for a new funnel, fill these in:

```php
define( 'VL_FUNNEL_FREE_COURSE_ID', 0 );       // <-- LearnDash course ID (integer)
define( 'VL_FUNNEL_TURNSTILE_SECRET', '' );    // <-- Cloudflare Turnstile SECRET key
define( 'VL_FUNNEL_DEFAULT_REDIRECT', '/smm/free-course-oto-1-smm/' );  // already correct
define( 'VL_FUNNEL_ALLOWED_REDIRECT_PREFIXES', '/smm/,/products/,/courses/,/welcome/' );  // already correct
```

### Where to find each value

**LearnDash course ID:**
- Log in to `learn.urbansketch.com` admin.
- Go to **LearnDash LMS → Courses**.
- Hover over the free course row — the URL shows `post=123`. That number is the ID.
- Alternative: open the course in the editor, the ID is in the URL bar.

**Turnstile secret key:**
- Log in to Cloudflare dashboard → **Turnstile** (left sidebar).
- Click **Add Site**. Name it `urban-sketch-smm-signup`. Widget mode: **Managed**.
- Allowed hostnames: `go.urbansketchcourse.com` (add `urbansketchcourse.com` and `www.urbansketchcourse.com` too if you want to future-proof).
- After saving, Cloudflare shows two keys:
  - **Site key** → goes in `smm-free-course/index.html` (see section 3)
  - **Secret key** → goes in `vl-funnel.php`

---

## 2. Deploy the MU-plugin to WordPress (5 minutes)

MU-plugins live at `/wp-content/mu-plugins/` on the WordPress server. They load automatically and **cannot be deactivated from the admin UI** (this is what makes them survive human error).

### Steps

1. Connect to the WordPress host (SFTP, cPanel File Manager, or hosting dashboard file explorer).
2. Navigate to `/wp-content/`.
3. If the folder `mu-plugins/` does not exist, create it.
4. Upload `vl-funnel.php` (the one you just filled in) into `/wp-content/mu-plugins/`.
5. Visit `learn.urbansketch.com/wp-admin` once to trigger the rewrite-rule flush (the plugin auto-flushes rewrites on first load).
6. Confirm it's active: go to **Plugins → Must-Use** in WP admin — you should see **"VL Funnel — Headless signup + auto-login"** listed.

### Verify the endpoint is responding

Open in a browser or curl:

```
https://learn.urbansketch.com/wp-json/vl/v1/
```

You should get a JSON response describing the `register` route. If you get a 404, the REST API isn't picking up the new route — visit `wp-admin → Settings → Permalinks` and click **Save** to flush rewrite rules.

---

## 3. Landing-page config (already populated)

The three live modal-signup pages all declare a `VL_CONFIG` block. Current production values:

**`smm-free-course/index.html`** (single page, own modal copy):
```js
var VL_CONFIG = {
  TURNSTILE_SITEKEY : '0x4AAAAAADA-IjYSyV5KoJYA',
  REGISTER_ENDPOINT : '/api/register',           // same-origin proxy in _worker.js
  FALLBACK_REG_URL  : 'https://learn.urbansketch.com/smm/free-course-reg-page-smm/',
  LOGIN_URL_BASE    : 'https://learn.urbansketch.com/wp-login.php',
  POST_SIGNUP_PATH  : '/smm/free-course-oto-1-smm/',
  FUNNEL_TAG        : 'smm-free-course',
  VARIANT           : 'smm-embedded'
};
```

**`free-course/a/index.html`** and **`free-course/b/index.html`** (share `free-course/shared/signup-modal.js`):
```js
window.VL_CONFIG = {
  TURNSTILE_SITEKEY : '0x4AAAAAADA-IjYSyV5KoJYA',
  REGISTER_ENDPOINT : '/api/register',
  FALLBACK_REG_URL  : 'https://learn.urbansketch.com/smm/free-course-reg-page-smm/',
  LOGIN_URL_BASE    : 'https://learn.urbansketch.com/wp-login.php',
  POST_SIGNUP_PATH  : '/smm/free-course-oto-1-smm/',
  FUNNEL_TAG        : 'free-course',
  VARIANT           : 'a'    // or 'b' in variant B
};
```

Key notes:
- `REGISTER_ENDPOINT` is the same-origin `/api/register` path. `_worker.js` forwards it server-to-server to WP.
- Site key is public — safe to commit. **Never** commit the secret (that belongs in `vl-funnel.php` on the WP host).
- `FALLBACK_REG_URL` is the safety-net manual-registration link shown inside any error display so a bug never costs a paid lead.
- `FUNNEL_TAG` is written into WP user meta (`vl_funnel_source`) and surfaced in Pixel + CAPI + gtag Lead events.

---

## 4. Deploy the landing page (1 minute)

The repo auto-deploys to Cloudflare Pages on every push to `main`.

```bash
cd /Users/neilmk/Projects/urban-sketch-landing-pages
git add _worker.js smm-free-course/ free-course/ wp-mu-plugin/
git commit -m "Roll out modal signup to /free-course/ variants + docs"
git push origin main
```

Wait ~60 seconds. Then visit:
- `https://go.urbansketchcourse.com/smm-free-course/`
- `https://go.urbansketchcourse.com/free-course/` (will route to `/a/` or `/b/`)

---

## 5. Three tests before going live with ads (10 minutes total)

Do these in this order. Use an incognito window for each one to keep cookies clean.

### Test A — New signup, happy path

1. Open `https://go.urbansketchcourse.com/smm-free-course/?a=36` (replace 36 with a real affiliate ID).
2. Scroll to any signup form. Enter a **brand new** email address you control.
3. Pass the Turnstile challenge if prompted.
4. Click **Get Instant Access**.
5. **Expected:**
   - Spinner appears briefly.
   - Browser redirects to `https://learn.urbansketch.com/vl-auto-login?t=...&r=/smm/free-course-oto-1-smm/`.
   - You land on `/smm/free-course-oto-1-smm/` already logged in.
   - Check inbox — welcome email with username + password arrives.
   - Check WP admin → **Users** — new user exists with meta `vl_funnel_source = smm-free-course`.
   - Check LearnDash → **Users → [new user] → Courses** — enrolled in the free course.
   - Check AffiliateWP → **Visits** — referral recorded against affiliate 36.

### Test B — Existing user, graceful path

1. New incognito window. Open `https://go.urbansketchcourse.com/smm-free-course/`.
2. Enter the **same email** you used in Test A.
3. Click **Get Instant Access**.
4. **Expected:**
   - Form fields swap to a "You are already registered!" panel.
   - Green box shows a **Log In to Access Your Course** button → links to `/wp-login.php?redirect_to=/smm/free-course-oto-1-smm/`.
   - Below that, a smaller "Forgot your password?" link → `/wp-login.php?action=lostpassword`.
   - **No duplicate user created, no duplicate welcome email sent.**

### Test C — Error recovery

1. New incognito window. Open `https://go.urbansketchcourse.com/smm-free-course/`.
2. Enter an obviously malformed email like `not-an-email`.
3. Click submit.
4. **Expected:**
   - Red error message appears: "Please enter a valid email address."
   - Form fields remain visible and editable.
   - User can correct the email and re-submit successfully.

If all three pass, you're clear to point the paid ads at the new URL.

---

## 6. Update paid ads to point at the new URL

Current URL (being replaced):
`https://learn.urbansketch.com/smm/free-course-reg-page-smm/`

New URL:
`https://go.urbansketchcourse.com/smm-free-course/`

Update in:
- Meta Ads Manager → all active campaigns targeting the free-course funnel.
- Any email/organic links pointing at the old registration page.
- Internal links in the Urban Sketch blog/site menu if present.

Leave the old WordPress page published for ~30 days as a safety net, then delete it once traffic logs confirm no residual hits.

---

## 7. Rollback plan (if something goes wrong)

**If the landing page breaks:** Revert the Cloudflare deploy via `git revert <commit> && git push`. Cloudflare redeploys in ~60 seconds.

**If the MU-plugin breaks registrations:** Rename `/wp-content/mu-plugins/vl-funnel.php` to `vl-funnel.php.off` via SFTP. WordPress stops loading it instantly. Point ads back at the old WordPress registration page while you debug.

**If you lose the Turnstile keys:** Generate new ones in the Cloudflare Turnstile dashboard. Update both the PHP file (secret) and the HTML file (site key), redeploy both.

---

## 8. What this solves (the "why")

The previous setup had **three failure points** stacked on top of each other:

1. The redirect logic lived in a theme `functions.php`-style file → a theme update could wipe it.
2. The redirect was keyed to a **page slug** → renaming the reg page broke it silently.
3. The redirect depended on a filter hook (`learndash-registration-form-redirect`) that LearnDash could rename in any future release.

The new architecture eliminates all three:

- MU-plugins don't auto-update and survive theme switches.
- The redirect is a **hardcoded constant** with no slug dependency.
- No LearnDash filter hook is used — the redirect is returned directly by our own REST endpoint.

Plus the pages themselves are now optimised for conversion with the Synthesis-winning copy (85/100 from the Copywriting Arena), an inline modal that captures first name + email on every CTA, Cloudflare Turnstile for spam prevention, and a proper existing-user flow.

## 8b. The `[vl_credentials]` shortcode

The host's `wp_mail()` pipe is currently broken. To avoid users never receiving their password:

1. During signup, the MU-plugin stores the generated password in user meta `_vl_funnel_initial_password` with a 15-minute expiry.
2. `wp_new_user_notification` is blocked via `pre_wp_mail` filter during `wp_insert_user` so the signup doesn't hang on a broken SMTP timeout.
3. On the OTO page (`/smm/free-course-oto-1-smm/`), place the shortcode `[vl_credentials]`. When a freshly-registered user lands there, it renders a credentials card with their username + password and a "Got them saved? Good. Now read the rest of this page." pattern interrupt. Then deletes the meta so the password is never shown twice.

If `wp_mail()` is fixed on the host later, you can re-enable the standard welcome email by removing the `pre_wp_mail` suppression in `vl-funnel.php` (`vl_funnel_block_new_user_emails`).

---

## 9. Config constants reference

All tunables live at the top of `vl-funnel.php`:

| Constant | Purpose | Default |
|---|---|---|
| `VL_FUNNEL_FREE_COURSE_ID` | LearnDash course to auto-enrol | `0` (MUST FILL) |
| `VL_FUNNEL_TURNSTILE_SECRET` | Cloudflare Turnstile secret | `''` (MUST FILL) |
| `VL_FUNNEL_ALLOWED_ORIGINS` | CSV of allowed CORS origins | 3 urbansketch domains |
| `VL_FUNNEL_DEFAULT_REDIRECT` | Post-signup path if none supplied | `/smm/free-course-oto-1-smm/` |
| `VL_FUNNEL_ALLOWED_REDIRECT_PREFIXES` | CSV of allowed redirect path prefixes (open-redirect defence) | `/smm/,/products/,/courses/,/welcome/` |
| `VL_FUNNEL_RATE_LIMIT_PER_HOUR` | Max registration attempts per IP per hour | `10` |
| `VL_FUNNEL_TOKEN_TTL` | Auto-login token lifetime (seconds) | `300` (5 min) |

To reuse this for a **different funnel later** (e.g., beginners-course), copy `vl-funnel.php` to `vl-funnel-beginners.php`, change the namespace prefix from `vl_funnel_` to `vl_funnel_beg_`, and swap the course ID + redirect constants. Or pass `funnel_tag` + `redirect_to` from the form and let one endpoint handle multiple funnels (already supported — the endpoint accepts both params).
