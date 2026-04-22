# PROJECT-STATE: Urban Sketch Landing Pages

**Repo:** github.com/V-Learn-Ltd/urban-sketch-landing-pages
**Live URL:** go.urbansketchcourse.com
**Hosting:** Cloudflare Pages (auto-deploy on push to main)
**Last Updated:** 2026-04-22

---

## What This Is

Static HTML landing pages for Urban Sketch ad funnels, hosted on Cloudflare Pages. A Cloudflare Worker (`_worker.js`) runs on every request to handle affiliate tracking (AffiliateWP cross-domain) and previously handled A/B routing (now client-side only).

---

## Active Funnels

| Funnel | URL | Structure | Signup |
|--------|-----|-----------|--------|
| Free Course | go.urbansketchcourse.com/free-course/ | `free-course/index.html` (JS router) → `a/` or `b/` | Inline modal (same-origin `/api/register`) |
| SMM Free Course | go.urbansketchcourse.com/smm-free-course/ | `smm-free-course/index.html` (single page, no A/B) | Inline modal (same-origin `/api/register`) |
| Beginners Course | go.urbansketchcourse.com/beginners-course/ | `beginners-course/index.html` (JS router) → `a/` or `b/` | External redirect to WP reg page |
| Rural/Landscape | go.urbansketchcourse.com/landscape-course/ | `landscape-course/index.html` (JS router) → `a/` or `b/` | External redirect to WP reg page |
| Hub Page | go.urbansketchcourse.com/ | `index.html` (links to all three funnels) | n/a |

---

## Architecture

```
Cloudflare Pages (static HTML)
  └── _worker.js (Cloudflare Worker — runs on every request)
        ├── Affiliate tracking: reads ?a= param, calls AffiliateWP REST API,
        │   sets affwp_affiliate_id / affwp_visit_id / affwp_campaign cookies
        ├── /api/register proxy: same-origin forward to WP MU-plugin
        │   (sidesteps CORS entirely — see "Modal Signup" below)
        └── AB_TESTS: ALWAYS EMPTY — do not add server-side routing here

Each funnel:
  funnel-name/
    index.html         ← JS router (assigns variant cookie, redirects to a/ or b/)
    a/index.html       ← Variant A (control)
    b/index.html       ← Variant B

Free-course variants share modal signup code:
  free-course/shared/
    signup-modal.css   ← Modal + form styles (loaded by each variant's <head>)
    signup-modal.js    ← Modal + Turnstile + submit flow (loaded at end of <body>)
```

### Modal Signup (Free Course + SMM Free Course)

These funnels register users **without leaving the landing page**. The flow:

1. User clicks any `[data-open-modal]` CTA → signup modal opens (first name + email).
2. Form submit → invisible Cloudflare Turnstile generates a token → JS POSTs to `/api/register`.
3. `_worker.js` forwards the POST server-to-server to `learn.urbansketch.com/wp-json/vl/v1/register`.
4. MU-plugin verifies Turnstile, creates the WP user, enrols in LearnDash, credits the affiliate from `affiliate_id` in the POST body, returns `{ ok, login_url }`.
5. JS fires Pixel Lead + CAPI + gtag (on success only) and redirects to the one-time auto-login URL → user lands on the OTO already logged in.
6. The OTO page renders `[vl_credentials]` shortcode → shows the user's initial password once (15-min TTL), so we don't depend on broken `wp_mail()`.

**Why the Worker proxy:** direct browser → WP CORS headers were being stripped on POST responses (OPTIONS preflight was fine), causing "We could not reach the server" errors. Routing through the Worker makes the browser see a same-origin request, and the WP endpoint sees a normal server-to-server POST.

**Turnstile config:**
- Site key in `VL_CONFIG.TURNSTILE_SITEKEY` (public, in each variant's HTML).
- Secret key in `VL_FUNNEL_TURNSTILE_SECRET` (MU-plugin constant).
- Turnstile verification **intentionally omits `remoteip`** — the Worker proxy means WP sees the Worker's IP, not the browser's, which would cause valid tokens to be rejected. The token itself is cryptographically signed proof.

**Fallback safety net:** if any step fails, `VL_CONFIG.FALLBACK_REG_URL` surfaces a manual-registration link in the error display so no paid lead is lost to a bug.

See `wp-mu-plugin/README.md` for the full WP-side deployment and config.

### Key Config (wrangler.jsonc)
- `AFFWP_REF_VAR = "a"` — affiliate parameter is `?a=36`, not `?ref=36`
- `AFFWP_PARENT_URL = "https://learn.urbansketch.com"`
- `AFFWP_CREDIT_LAST = "true"` — always creates a new visit record
- `AFFWP_COOKIE_DAYS = "400"`

### How OF Attribution Works
Order form visits on `learn.urbansketch.com` are attributed to the landing page via the HTTP `Referer` header — NOT via `?a=36` in the buy URL. When a visitor on `go.urbansketchcourse.com/beginners-course/a/` clicks buy, the WordPress order form receives `Referer: https://go.urbansketchcourse.com/beginners-course/a/`. AffiliateWP uses this to record the visit and link it to affiliate 36.

---

## Critical Rules (from hard lessons — 2026-04-07)

### A/B Testing — ALWAYS client-side, NEVER server-side

**`AB_TESTS` in `_worker.js` MUST remain empty.**

Server-side 302 routing inflates LP visit counts with bot traffic. Bots follow HTTP redirects and create AffiliateWP visit records — making LP→OF conversion rates look impossibly low (was showing 0.17% for beginners instead of ~8%).

Client-side JS routing (`window.location.replace()`) is invisible to bots. Always use the JS router pattern in `index.html`. See CLAUDE.md for the template.

**This is what caused the beginners funnel tracking failure discovered 2026-04-07.**

---

## Current A/B Test Status

| Funnel | Variant A | Variant B | Cookie Name |
|--------|-----------|-----------|-------------|
| Free | `free-course/a/` | `free-course/b/` | `us_fc_variant` |
| Beginners | `beginners-course/a/` | `beginners-course/b/` | `us_bc_variant` |
| Rural/Landscape | `landscape-course/a/` | `landscape-course/b/` | `us_lc_variant` |

All currently 50/50 splits.

---

## Immediate Next Steps

1. **CRO investigation (beginners funnel):** Now that bot inflation is removed, the real LP→OF rate for beginners needs diagnosing. Run `/lp-diagnostic usc beginners-course-paid` when AffiliateWP has a clean 7 days of data post-fix.
2. **Monitor:** Check beginners LP visit counts over the next 3-7 days to confirm they've dropped to realistic levels (should be comparable to free/rural on a per-spend basis).

---

## Deployment

Any change to HTML, JS, or config files:
1. `git add <files>`
2. `git commit -m "description"`
3. `git push origin main`
4. Cloudflare Pages deploys automatically (~60 seconds)
5. Verify at go.urbansketchcourse.com

See CLAUDE.md for full instructions.

---

## Key Files

| File | Purpose |
|------|---------|
| `_worker.js` | Cloudflare Worker — affiliate tracking + `/api/register` proxy. `AB_TESTS` must stay empty. |
| `wrangler.jsonc` | Cloudflare Pages config + env vars |
| `CLAUDE.md` | Full instructions for building, deploying, A/B testing |
| `*/index.html` | JS routers for each funnel |
| `*/a/index.html` | Variant A (control) for each funnel |
| `*/b/index.html` | Variant B for each funnel |
| `free-course/shared/signup-modal.css` | Shared modal + form styles (variants a & b) |
| `free-course/shared/signup-modal.js` | Shared modal + Turnstile + submit handler |
| `smm-free-course/index.html` | Single-variant page; inlines its own copy of the modal |
| `wp-mu-plugin/vl-funnel.php` | WP MU-plugin: `/wp-json/vl/v1/register` + auto-login + `[vl_credentials]` |
| `wp-mu-plugin/README.md` | Deployment, config, test protocol for the MU-plugin |
