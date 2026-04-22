# Morning Briefing — Headless Signup System (SMM + Free Course A/B)

**Date:** 2026-04-22 (overnight build + same-day extension to /free-course/a/ + /free-course/b/)
**What this solves:** The brittle LearnDash redirect that keeps breaking + the 6% conversion rate on the current registration page. Now rolled out to the split-tested free-course variants too.

---

## What got built

A complete replacement for `https://learn.urbansketch.com/smm/free-course-reg-page-smm/`. Four moving parts:

### 1. Conversion-optimised landing page (new)
**File:** `smm-free-course/index.html`
**Live URL (after deploy):** `https://go.urbansketchcourse.com/smm-free-course/`

- Full Synthesis-winning copy from the arena (85/100 — BJ 25% + DD 30% + CJ 20% + CM 15% + AE 10%).
- **Modal signup** — every CTA button opens the same inline modal (first name + email). User registers without ever leaving the page.
- Mobile sticky bar at the bottom.
- Social proof popup.
- Proper existing-user handling: the modal swaps to a "You are already registered!" panel with a **Log In** button + forgot-password link.
- Cloudflare Turnstile (invisible/managed mode) to stop the spam signups we had on March 23.
- All existing tracking preserved: Clarity, GA4, FB Pixel, CAPI.
- **Fixed an optimisation mistake in the old page:** the FB Pixel `Lead` event now fires ONLY on successful new registration, not on every button click.
- **Same-origin proxy architecture:** browser POSTs to `/api/register` → Cloudflare Worker forwards server-to-server to the WP MU-plugin. This sidesteps CORS entirely (the WP host was stripping `Access-Control-Allow-Origin` on POST responses only, which is why direct cross-origin calls were failing).

### 1b. Free-course A/B variants ported to the same modal (same-day)
**Files:** `free-course/a/index.html`, `free-course/b/index.html`
**Shared modal code:** `free-course/shared/signup-modal.css` + `free-course/shared/signup-modal.js`

Both A/B variants now use the identical modal signup pattern. The modal CSS and JS are extracted into a single shared module so future copy/UI tweaks edit one file, not three. Each variant declares its own `VL_CONFIG` block with variant-specific tracking (`variant: 'a'` vs `'b'`).

The old `handleCTA()` redirect to `learn.urbansketch.com/smm/free-course-reg-page-smm/` has been removed. Every CTA on the page now opens the modal instead.

### 2. MU-plugin "service window" (new)
**File:** `wp-mu-plugin/vl-funnel.php`
**Endpoint:** `POST https://learn.urbansketch.com/wp-json/vl/v1/register`

- Takes `email`, `turnstile_token`, `redirect_to`, `first_name`, `funnel_tag`, `affiliate_id`, `campaign` (all JSON body).
- Verifies Turnstile (without `remoteip` — see note below) → rate-limits by IP → creates user → enrols in LearnDash → credits AffiliateWP from the `affiliate_id` POST field → stores initial password in user meta (15-min TTL) → returns a one-time auto-login URL.
- If user exists: short-circuits, returns `{existing: true, login_url, lost_url}`. No duplicates.
- Second endpoint `GET /vl-auto-login?t=TOKEN&r=PATH` consumes the token, sets the auth cookie, redirects.
- Third piece: `[vl_credentials]` shortcode renders the user's initial password once on the OTO page (then deletes the meta) — needed because `wp_mail()` is currently broken on the host.
- Blocks `wp_new_user_notification` via `pre_wp_mail` filter during `wp_insert_user` so signups don't hang on broken SMTP.
- Hardened: open-redirect protection via path prefix allowlist, origin-checked CORS, rate limiting, short-lived tokens (5-min TTL).
- **Turnstile verification intentionally omits `remoteip`** — the Worker proxy means the WP endpoint sees the Worker's IP, not the browser's. Passing that as `remoteip` causes Turnstile to reject valid tokens. The cryptographic token is the signed proof on its own.
- **AffiliateWP credit** reads from the POST body (not cookies). Cookies don't cross from `go.urbansketchcourse.com` to `learn.urbansketch.com`, so the LP JS reads `affwp_affiliate_id` cookie or `?a=` / `?ref=` param and puts it in the body.

### 3. Worker same-origin proxy (new)
**File:** `_worker.js` (routes added)

Handles `POST /api/register` and `OPTIONS /api/register`. The POST path does a server-to-server `fetch()` against `learn.urbansketch.com/wp-json/vl/v1/register` with the browser body passed through. Because the browser sees only a same-origin request, CORS never enters the picture. This is what unblocked the "We could not reach the server" issue we hit yesterday.

### 4. Deployment guide (updated)
**File:** `wp-mu-plugin/README.md`

Step-by-step: fill in 2 constants, upload the PHP file, deploy the landing pages, run 3 tests, point ads at the new URLs.

---

## What you need to do this morning (~20 min)

In this order:

**1. Get your config values** (5 min)
- Log into WP admin → LearnDash → Courses → hover over the free course row → note the ID number in the URL.
- Log into Cloudflare dashboard → Turnstile → Add Site → name it `urban-sketch-smm-signup`, allowed hostnames `go.urbansketchcourse.com`. Save. Copy the **site key** and **secret key**.

**2. Fill in the PHP file** (1 min)
- Open `wp-mu-plugin/vl-funnel.php`.
- Fill in `VL_FUNNEL_FREE_COURSE_ID` and `VL_FUNNEL_TURNSTILE_SECRET`.

**3. Fill in the HTML file** (1 min)
- Open `smm-free-course/index.html`.
- Find `VL_CONFIG` near the top of the script block.
- Replace `__REPLACE_TURNSTILE_SITEKEY__` with the Turnstile **site key**.

**4. Upload the MU-plugin** (5 min)
- SFTP / cPanel → `/wp-content/mu-plugins/` → upload `vl-funnel.php`.
- Visit `learn.urbansketch.com/wp-admin/plugins.php?plugin_status=mustuse` — confirm "VL Funnel" appears.

**5. Deploy the landing page** (2 min)
```bash
cd /Users/neilmk/Projects/urban-sketch-landing-pages
git add smm-free-course/ wp-mu-plugin/
git commit -m "Add /smm-free-course/ headless signup + vl-funnel MU-plugin"
git push origin main
```
Wait 60s for Cloudflare Pages to deploy.

**6. Run the three tests** (5 min)
See `wp-mu-plugin/README.md` section 5 — new signup / existing user / malformed email. All three should pass cleanly before pointing ads at the new URL.

**7. Update Meta ads** (5 min)
Swap the destination URL in your active campaigns from:
`https://learn.urbansketch.com/smm/free-course-reg-page-smm/`
to:
`https://go.urbansketchcourse.com/smm-free-course/`

---

## Why this is bulletproof (the architecture decisions)

1. **MU-plugins can't be deactivated from the admin UI** — no one can accidentally click the wrong checkbox.
2. **MU-plugins don't auto-update** — no plugin update can break the logic.
3. **No theme dependency** — a theme switch or theme update can't touch this.
4. **No LearnDash filter hook dependency** — we own the redirect logic end-to-end. If LearnDash changes their internal hooks in a future release, this keeps working.
5. **No page slug dependency** — the redirect is a hardcoded constant, not keyed off a slug that someone might rename.
6. **No same-origin assumption** — the landing page is on a different domain entirely, which means the LearnDash registration form on the WordPress side never runs, so none of its quirks apply.

This is the pattern professional SaaS signups use. The marketing site and the app are fully decoupled.

---

## Conversion-rate bet

Current: ~6% on the WordPress registration page (hard form, no copy, no social proof, no above-the-fold CTA).

New page has:
- A 35-second hook (name + first testimonial visible before any form).
- Social proof in three places (popup, numbered stats, named testimonials).
- Form copy that matches the promise of the ad.
- Two forms so the committed buyer can sign up at the hero, the skeptic can scroll-read and sign up at the bottom.
- Existing-user handling that doesn't look like a failure.

Realistic expectation: **15-25% conversion rate on cold paid traffic** for a free course with this level of social proof. A 3× lift is the working hypothesis — track it in Clarity and the ads dashboard.

---

## Outstanding items / flagged assumptions

- **`VL_FUNNEL_FREE_COURSE_ID = 39746`** — filled in, confirmed enrolling correctly.
- **Turnstile keys in production:** site key `0x4AAAAAADA-IjYSyV5KoJYA`, secret set in the MU-plugin. Same Turnstile widget serves SMM + free-course A/B.
- **Welcome email via `wp_mail()` is disabled.** The host's mail pipe is broken — any `wp_mail()` call during signup was hanging for 10-30 seconds (three sync SMTP timeouts). We now block `wp_new_user_notification` and skip the custom welcome email during `wp_insert_user`. LearnDash sends a branded welcome via arpReach (separate system) and the `[vl_credentials]` shortcode on the OTO page shows the initial password once. If the mail pipe is fixed later, re-enable `wp_new_user_notification` by removing the `pre_wp_mail` suppression in `vl-funnel.php`.
- **`[vl_credentials]` shortcode must be placed on the OTO page** (`/smm/free-course-oto-1-smm/` and any other post-signup page in the funnel). It renders the password once, then deletes the stored meta. Credentials are held in user meta for 15 minutes; after that the shortcode renders nothing.
- **A/B is live on `/free-course/`** (two variants, both using the modal). `/smm-free-course/` is still a single page — no A/B on it yet.
- **Rate limit is 10 registrations per IP per hour.** If you have a shared-IP environment (offices, VPN users), consider raising to 30-50. Currently conservative.
- **Turnstile widget mode is "Managed"** — Cloudflare decides when to show the challenge vs. auto-pass. For a free-course signup this is the right balance. If you see spam leak through after a week, switch to "Non-interactive" (harder) in the Turnstile dashboard.
- **Turnstile verification drops `remoteip`** — do NOT add it back. Because the browser's request goes through the Worker, the WP endpoint sees the Worker's IP, not the user's. Including that as `remoteip` causes every valid token to be rejected.

---

## Files at a glance

```
urban-sketch-landing-pages/
├── _worker.js                       ← Cloudflare Worker (adds /api/register proxy)
├── smm-free-course/
│   └── index.html                   ← Single-page landing + modal signup
├── free-course/
│   ├── index.html                   ← JS A/B router (unchanged)
│   ├── a/index.html                 ← Variant A — modal signup (ported)
│   ├── b/index.html                 ← Variant B — modal signup (ported)
│   └── shared/
│       ├── signup-modal.css         ← Shared modal + form styles
│       └── signup-modal.js          ← Shared modal + Turnstile + submit handler
├── wp-mu-plugin/
│   ├── vl-funnel.php                ← MU-plugin (production config in place)
│   └── README.md                    ← Deployment + test guide
├── PROJECT-STATE.md                 ← Architecture + active funnels index
└── MORNING-BRIEFING.md              ← this file
```

Push any HTML / CSS / JS / `_worker.js` change to `main` → Cloudflare Pages auto-deploys in ~60s. Uploading `vl-funnel.php` to `/wp-content/mu-plugins/` on the WordPress host is a separate manual step.

---

## If anything breaks

Rollback instructions are in `wp-mu-plugin/README.md` section 7. The landing page can be reverted with one `git revert`. The MU-plugin can be disabled by renaming it to `.off` via SFTP. No permanent damage is possible — all the user data (WordPress users, LearnDash enrolments, AffiliateWP referrals) stays in the database even if the plugin file is removed.
