# Morning Briefing — SMM Free Course Signup Rebuild

**Date:** 2026-04-22 (overnight build)
**What this solves:** The brittle LearnDash redirect that keeps breaking + the 6% conversion rate on the current registration page.

---

## What got built

A complete replacement for `https://learn.urbansketch.com/smm/free-course-reg-page-smm/`. Three moving parts:

### 1. Conversion-optimised landing page (new)
**File:** `smm-free-course/index.html`
**Live URL (after deploy):** `https://go.urbansketchcourse.com/smm-free-course/`

- Full Synthesis-winning copy from the arena (85/100 — BJ 25% + DD 30% + CJ 20% + CM 15% + AE 10%).
- Two inline signup forms (hero + final CTA) — user can register without ever leaving the page.
- All intermediate CTA buttons smooth-scroll to the final form and focus the email input.
- Mobile sticky bar at the bottom.
- Social proof popup.
- Proper existing-user handling: if the email is already registered, the form swaps to a "You are already registered!" panel with a **Log In** button + forgot-password link.
- Cloudflare Turnstile on each form (invisible/managed mode) to stop the spam signups we had on March 23.
- All existing tracking preserved: Clarity, GA4, FB Pixel, CAPI.
- **Fixed an optimisation mistake in the old page:** the FB Pixel `Lead` event now fires ONLY on successful new registration, not on every button click.

### 2. MU-plugin "service window" (new)
**File:** `wp-mu-plugin/vl-funnel.php`
**Endpoint:** `POST https://learn.urbansketch.com/wp-json/vl/v1/register`

- Takes `email`, `turnstile_token`, `redirect_to`, optional `first_name`, `funnel_tag`.
- Verifies Turnstile → rate-limits by IP → creates user → enrols in LearnDash → credits AffiliateWP from the `affwp_ref` cookie → emails password → returns a one-time auto-login URL.
- If user exists: short-circuits, returns `{existing: true, login_url}`. No duplicates, no spam.
- Second endpoint `GET /vl-auto-login?t=TOKEN&r=PATH` consumes the token, sets the auth cookie, redirects.
- Hardened: open-redirect protection via path prefix allowlist, origin-checked CORS, rate limiting, short-lived tokens (5-min TTL).

### 3. Deployment guide (new)
**File:** `wp-mu-plugin/README.md`

Step-by-step: fill in 4 constants, upload the PHP file, deploy the landing page, run 3 tests, point ads at the new URL.

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

- **`VL_FUNNEL_FREE_COURSE_ID` is `0` in the PHP file.** The plugin won't enrol anyone until you fill this in. It will still create the user and log them in — enrolment is skipped silently (logged as a warning in `error_log`) rather than breaking the flow. Double-check this runs cleanly on first test.
- **Welcome email template is plain text.** If you want branded HTML, swap the `wp_mail()` call body in `vl_funnel_send_welcome_email` — currently a bare "Here's your password, click this link" template. Works but not branded.
- **No A/B variant on this page.** Unlike `/free-course/`, `/beginners-course/`, etc., this page does NOT use the `a/` + `b/` JS-router pattern. If you want to A/B test it, we'll need to spin up a router `index.html` and move the current file to `a/`. Left as a single page so you can ship it today — happy to add A/B in a follow-up once we have a baseline conversion number.
- **Rate limit is 10 registrations per IP per hour.** If you have a shared-IP environment (offices, VPN users), consider raising to 30-50. Currently conservative.
- **Turnstile widget mode is "Managed"** — Cloudflare decides when to show the challenge vs. auto-pass. For a free-course signup this is the right balance. If you see spam leak through after a week, switch to "Non-interactive" (harder) in the Turnstile dashboard.

---

## Files at a glance

```
urban-sketch-landing-pages/
├── smm-free-course/
│   └── index.html                   ← NEW landing page (needs Turnstile site key)
├── wp-mu-plugin/
│   ├── vl-funnel.php                ← NEW MU-plugin (needs 2 config values)
│   └── README.md                    ← NEW deployment guide
└── MORNING-BRIEFING.md              ← this file
```

All files are staged locally but **not yet committed**. Commit them after you've filled in the config values — the commit + push will trigger the Cloudflare Pages deploy immediately. Uploading the PHP file to WordPress is a separate manual step (step 4 above).

---

## If anything breaks

Rollback instructions are in `wp-mu-plugin/README.md` section 7. The landing page can be reverted with one `git revert`. The MU-plugin can be disabled by renaming it to `.off` via SFTP. No permanent damage is possible — all the user data (WordPress users, LearnDash enrolments, AffiliateWP referrals) stays in the database even if the plugin file is removed.
