# VL Funnel — Deployment & Testing Guide

This folder contains the WordPress-side "service window" for the Cloudflare-hosted signup page at `/smm-free-course/`. The landing page is fully decoupled from WordPress — it calls a REST endpoint to register the user, then sends them to a one-time auto-login URL.

**Architecture:**

```
Visitor → go.urbansketchcourse.com/smm-free-course/   (Cloudflare Pages, static HTML + JS form)
         │
         │  POST /wp-json/vl/v1/register    (cross-origin fetch + Turnstile token)
         ▼
         learn.urbansketch.com  (WordPress + LearnDash + AffiliateWP + this MU-plugin)
         │   ├─ verifies Turnstile
         │   ├─ rate-limits by IP
         │   ├─ creates user + enrols in LearnDash course
         │   ├─ credits AffiliateWP referral (from affwp_ref cookie)
         │   ├─ emails password + welcome
         │   └─ returns one-time auto-login URL
         │
         │  redirect → /vl-auto-login?t=TOKEN&r=/smm/free-course-oto-1-smm/
         ▼
         User lands logged-in on /smm/free-course-oto-1-smm/
```

Slug changes, theme changes, and plugin updates can't break this — everything runs through the MU-plugin, and MU-plugins don't auto-update.

---

## 1. Fill in the config constants (5 minutes)

Open `vl-funnel.php` and fill in **four values** at the top:

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

## 3. Fill in the landing-page config (2 minutes)

Open `/Users/neilmk/Projects/urban-sketch-landing-pages/smm-free-course/index.html` and find this block near the top of the `<script>` section (search for `VL_CONFIG`):

```js
var VL_CONFIG = {
  TURNSTILE_SITEKEY : '__REPLACE_TURNSTILE_SITEKEY__',
  REGISTER_ENDPOINT : 'https://learn.urbansketch.com/wp-json/vl/v1/register',
  LOGIN_URL_BASE    : 'https://learn.urbansketch.com/wp-login.php',
  POST_SIGNUP_PATH  : '/smm/free-course-oto-1-smm/',
  FUNNEL_TAG        : 'smm-free-course',
  VARIANT           : 'smm-embedded'
};
```

Replace `__REPLACE_TURNSTILE_SITEKEY__` with the **Site key** from step 1 (NOT the secret — the secret stays server-side in the PHP file).

Everything else is already correct unless you want to change the post-signup redirect.

---

## 4. Deploy the landing page (1 minute)

The repo auto-deploys to Cloudflare Pages on every push to `main`.

```bash
cd /Users/neilmk/Projects/urban-sketch-landing-pages
git add smm-free-course/ wp-mu-plugin/
git commit -m "Add /smm-free-course/ headless signup + vl-funnel MU-plugin"
git push origin main
```

Wait ~60 seconds. Then visit `https://go.urbansketchcourse.com/smm-free-course/`.

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

Plus the page itself is now optimised for conversion with the Synthesis-winning copy (85/100 from the Copywriting Arena), two inline signup forms, Cloudflare Turnstile for spam prevention, and a proper existing-user flow.

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
