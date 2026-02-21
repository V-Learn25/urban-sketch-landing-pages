# Cloudflare Pages + AffiliateWP Cross-Domain Tracking + A/B Testing

## Landing Page Deployment Skill

A comprehensive skill for building, QA-ing, and deploying landing pages lives at:
`~/.claude/skills/landing-page-deployment/SKILL.md`

**Use it when:** Building a new page, running pre-launch QA, deploying, setting up GeoIP, or checking accessibility. It includes 8 frameworks covering every step from build to weekly CRO analysis, plus a linear runbook for team handoff.

**Quick reference:** The skill has a `RUNBOOK-new-page.md` in `references/` — a zero-interpretation, step-by-step deployment script anyone can follow.

---

## What This Project Does

Static HTML landing pages hosted on Cloudflare Pages, with a Cloudflare Worker that:
1. **Affiliate tracking** — replicates the "child site" behaviour of the AffiliateWP Cross Domain Tracker plugin (creates visits via REST API, sets cookies, rewrites outbound links)
2. **A/B split testing** — routes visitors to page variants at the edge (zero latency), with cookie-based sticky sessions
3. **Heatmap analytics** — Microsoft Clarity tags each session with the active variant, so you can filter heatmaps and recordings per variant

## Architecture

```
Visitor clicks affiliate link
  -> go.urbansketchcourse.com/beginners-course/?a=36
  -> Cloudflare Worker intercepts (run_worker_first: true)
  -> Worker checks for active A/B test on this path
  -> If A/B test active: assigns variant via cookie, serves variant HTML
  -> Worker calls AffiliateWP REST API: POST /wp-json/affwp/v1/visits
  -> Worker sets cookies: affwp_affiliate_id, affwp_visit_id, affwp_campaign
  -> HTMLRewriter injects Clarity variant tag into <head>
  -> Worker serves static HTML page (with Clarity script)
  -> Clarity records session tagged with variant name
  -> Client-side JS reads cookies, rewrites Buy Now links to include ?a=36&visit={id}
  -> Visitor clicks Buy Now -> learn.urbansketch.com picks up attribution
```

## Project Structure

```
/
  _worker.js           - Cloudflare Worker (affiliate tracking + A/B routing + Clarity tagging)
  wrangler.jsonc       - Cloudflare config (vars, assets, worker entry point)
  .assetsignore        - Prevents _worker.js from being served as a static file
  .mcp.json            - MCP server config: Clarity + GoMarble Meta Ads (gitignored)
  .gitignore           - Excludes .mcp.json, scripts/.env, gomarble venv
  CLAUDE.md            - This file (project runbook + CRO process)
  beginners-course/
    index.html         - Landing page (control) — cold traffic (ads)
    variant-b.html     - A/B test variant (when test is active)
    start/
      index.html       - Warm-traffic landing page (email list, organic)
    favicon.jpg        - Site favicon
  scripts/
    pull-affwp-data.js - AffiliateWP weekly CRO report (Node.js, zero dependencies)
    .env               - AffiliateWP API credentials (gitignored)
    .env.example        - Template for .env
    gomarble-mcp/
      server.py        - GoMarble Facebook Ads MCP server (from github.com/gomarble-ai)
      venv/            - Python 3.12 virtual environment (gitignored)
  [future-course]/
    index.html         - Additional landing pages follow same pattern
```

## Critical Gotchas (Learned the Hard Way)

### 1. Environment Variables MUST Be in wrangler.jsonc

**Problem:** Plain-text environment variables set via the Cloudflare dashboard get silently wiped on every deployment when a `wrangler.jsonc` file exists. Only encrypted secrets (set via `wrangler pages secret put` or the dashboard's "Encrypt" toggle) survive.

**Solution:** All non-secret config goes in `wrangler.jsonc` under `"vars"`. Only API keys/tokens go as dashboard secrets.

```jsonc
"vars": {
  "AFFWP_PARENT_URL": "https://learn.urbansketch.com",
  "AFFWP_REF_VAR": "a",
  "AFFWP_COOKIE_DAYS": "400",
  "AFFWP_CREDIT_LAST": "true"
}
```

### 2. run_worker_first: true Is Essential

**Problem:** By default, Cloudflare Pages serves static assets directly from the CDN WITHOUT invoking the worker. The worker only runs for requests that don't match a static file. Since our landing pages ARE static files, the worker never runs.

**Solution:** Set `"run_worker_first": true` in the assets config. This makes the worker intercept ALL requests, including static asset requests.

```jsonc
"assets": {
  "directory": "./",
  "binding": "ASSETS",
  "run_worker_first": true
}
```

**Performance note:** This means ALL requests (images, CSS, JS) go through the worker. The worker returns them immediately if there's no affiliate parameter, so the overhead is minimal. If performance becomes a concern, Cloudflare supports `"run_worker_first": ["/*.html", "/*/"]` to filter by path pattern.

### 3. .assetsignore Must Exclude _worker.js

**Problem:** Without `.assetsignore`, Cloudflare uploads `_worker.js` as a publicly-accessible static file, exposing your code.

**Solution:** Create `.assetsignore` containing `_worker.js`.

### 4. The Referral Variable Is "a" Not "ref"

The affiliate links use `?a=36` (not the AffiliateWP default `?ref=36`). This is configured via `AFFWP_REF_VAR` in wrangler.jsonc and must match in the client-side JS (`var refVar = 'a'`).

### 5. AffiliateWP REST API Uses v1, Not v2

The API endpoint is `/wp-json/affwp/v1/visits`. Authentication is HTTP Basic with `public_key:token`. The visit creation endpoint expects parameters as URL query string params on a POST request (not in the request body).

### 6. Content-Type Detection for HTML

The worker checks BOTH the content-type header from `env.ASSETS.fetch()` AND the URL path pattern to determine if a request is for an HTML page. Relying only on content-type failed because Cloudflare doesn't always set it correctly for directory index files.

### 7. Secrets Setup (One-Time Per Project)

```bash
npx wrangler pages secret put AFFWP_PUBLIC_KEY --project-name=<project-name>
npx wrangler pages secret put AFFWP_TOKEN --project-name=<project-name>
```

Or set via Cloudflare dashboard: Settings > Environment variables > Production (make sure "Encrypt" is checked).

## Adding a New Landing Page (Same Domain)

1. Create a new directory: `mkdir new-course-name`
2. Add `index.html` with the landing page content
3. Add the client-side link rewriting JS at the bottom of the HTML (before `</body>`):

```html
<script>
/* AffiliateWP cross-domain link rewriting */
(function(){
  var parentUrl = 'https://learn.urbansketch.com';
  var refVar = 'a';

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : '';
  }

  var affiliateId = getCookie('affwp_affiliate_id');
  if (!affiliateId) return;

  var visitId = getCookie('affwp_visit_id');
  var campaign = getCookie('affwp_campaign');

  var baseUrl = parentUrl.replace(/\/$/, '');

  var links = document.querySelectorAll("a[href^='" + baseUrl + "']");
  links.forEach(function(link) {
    var href = link.getAttribute('href');

    var hash = '';
    var hashIdx = href.indexOf('#');
    if (hashIdx !== -1) {
      hash = href.substring(hashIdx);
      href = href.substring(0, hashIdx);
    }

    var re = new RegExp('([?&])' + refVar + '=[^&#]*', 'i');
    if (re.test(href)) {
      href = href.replace(re, '$1' + refVar + '=' + affiliateId);
    } else {
      href += (href.indexOf('?') !== -1 ? '&' : '?') + refVar + '=' + affiliateId;
    }

    if (visitId) {
      href += '&visit=' + visitId;
    }

    if (campaign) {
      href += '&campaign=' + encodeURIComponent(campaign);
    }

    link.setAttribute('href', href + hash);
  });
})();
</script>
```

4. Commit and push. The worker handles everything else automatically.

## Setting Up a New Domain From Scratch

### Prerequisites
- GitHub repo for the landing pages
- Cloudflare account with the domain
- AffiliateWP REST API credentials (public key + token) from the WordPress site

### Steps

1. **Clone or create the repo** with this file structure:
   - `_worker.js` (copy from this project - it's domain-agnostic)
   - `wrangler.jsonc` (copy and update `AFFWP_PARENT_URL` and `AFFWP_REF_VAR`)
   - `.assetsignore` (copy as-is)
   - `your-page/index.html` (with client-side JS above)

2. **Create Cloudflare Pages project:**
   - Cloudflare dashboard > Workers & Pages > Create > Pages > Connect to Git
   - Select the GitHub repo
   - Build settings: leave blank (no build command needed, output directory is `/`)
   - Deploy

3. **Set secrets** (one-time):
   ```bash
   npx wrangler pages secret put AFFWP_PUBLIC_KEY --project-name=<project-name>
   npx wrangler pages secret put AFFWP_TOKEN --project-name=<project-name>
   ```

4. **Set custom domain:**
   - Cloudflare Pages project > Custom domains > Add
   - e.g. `go.yournewdomain.com`

5. **Test:**
   ```bash
   # Should return Set-Cookie headers with affwp_affiliate_id and affwp_visit_id
   curl -sI "https://go.yournewdomain.com/your-page/?a=36" | grep -i set-cookie
   ```

6. **Verify in AffiliateWP:**
   - Check Affiliates > Visits in WordPress admin
   - Should see a visit with the landing page URL

## A/B Split Testing

### How It Works

The worker handles A/B testing at the edge — zero client-side latency, no third-party tools, no cost. The visitor always sees the same URL (e.g. `/beginners-course/`); the worker silently serves either `index.html` or `variant-b.html` based on a cookie.

- **Cookie-based sticky sessions**: Once assigned, a visitor always sees the same variant (30-day cookie)
- **Weighted splits**: Configure any split ratio (50/50, 70/30, 90/10)
- **Clarity auto-tagging**: HTMLRewriter injects the variant name into Clarity via `clarity("set", testName, variantName)` — filter heatmaps and recordings by variant in Clarity dashboard
- **No URL changes**: Ad links, UTM parameters, and affiliate tracking all work identically across variants

### Running a Test

1. **Create the variant file:**
   ```bash
   cp beginners-course/index.html beginners-course/variant-b.html
   ```

2. **Edit the copy** in `variant-b.html` — change headline, CTA, social proof, whatever you're testing.

3. **Make sure variant-b.html has the Clarity script** in `<head>` and the affiliate link rewriting JS before `</body>` (they'll already be there if you copied from index.html).

4. **Activate the test** by uncommenting/adding the config in `_worker.js`:
   ```javascript
   const AB_TESTS = {
     '/beginners-course/': {
       variants: [
         { name: 'control',   path: '/beginners-course/index.html',      weight: 50 },
         { name: 'variant-b', path: '/beginners-course/variant-b.html',  weight: 50 },
       ],
     },
   };
   ```

5. **Deploy:**
   ```bash
   git add . && git commit -m "Start A/B test: beginners course headline" && git push
   ```

6. **Verify** in an incognito window. Check DevTools > Application > Cookies for `ab_beginners-course=control` or `ab_beginners-course=variant-b`.

### Ending a Test

1. Remove or comment out the test entry in `AB_TESTS`
2. If the variant won, replace `index.html` with the winning variant's content
3. Delete the variant HTML file
4. Commit and push

### Analysing Results

**In Microsoft Clarity** (clarity.microsoft.com):
- Go to Filters > Custom Tags
- Filter by tag name (e.g. `beginners-course`) and value (`control` vs `variant-b`)
- Compare heatmaps, scroll depth, click maps, and recordings side by side

**Conversion tracking:**
- The primary metric is CTA click-through rate (clicks on Buy Now links to learn.urbansketch.com)
- Track this in Clarity via click maps on the CTA button area
- For end-to-end purchase attribution: the affiliate `visit_id` is already tracked in AffiliateWP — you can cross-reference which variant a converting visitor saw

**Statistical significance:**
- Use https://abtestguide.com/calc/ — enter visitors and conversions per variant
- Pre-plan test duration with https://www.convert.com/calculator/
- Run tests for at least 14 days regardless of sample size (day-of-week effects)
- With <200 daily visitors, test BIG changes (different headlines/angles, not button colours)

### Multiple Simultaneous Tests

You can run tests on different pages at the same time (one test per page). Each test gets its own cookie. Do NOT run multiple tests on the same page — with landing page traffic volumes you won't have enough data.

## Microsoft Clarity (Heatmaps & Session Recordings)

**Project ID:** `bn4hwc3a8c`
**Dashboard:** https://clarity.microsoft.com

Clarity is installed on all landing pages via a `<script>` tag in `<head>`. It provides:
- **Click maps** — where visitors click (and don't click)
- **Scroll depth / attention maps** — how far visitors scroll, where they stop
- **Session recordings** — watch real visitor sessions
- **Dead click detection** — elements visitors click that aren't clickable
- **Rage click detection** — frustrated repeated clicking

### Adding Clarity to a New Page

Add this to the `<head>` of every landing page HTML file:

```html
<!-- Microsoft Clarity -->
<script type="text/javascript">
(function(c,l,a,r,i,t,y){
  c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
  t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
  y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
})(window, document, "clarity", "script", "bn4hwc3a8c");
</script>
```

### Clarity MCP Server (AI Integration)

The Microsoft Clarity MCP server is configured in `.mcp.json` (gitignored).
It connects automatically when you open Claude Code in this project.

**Tools available:**
- `query-analytics-dashboard` — pull scroll depth, engagement, traffic, dead clicks, rage clicks
- `list-session-recordings` — find recordings by URL, device, browser, country
- `query-documentation-resources` — search Clarity docs

**Limitations:** Max 10 API requests/day, last 1-3 days of data, 1000 rows max.
For actual heatmap visuals and click coordinates, use the Clarity dashboard directly.

---

## Weekly CRO Process (Monday Morning Rhythm)

This is the complete step-by-step process for running continuous landing page optimisation. It combines the OfferNomics constraint identification framework with data from three sources: GoMarble (Meta ads), AffiliateWP (conversions), and Clarity (behaviour).

### Your Funnels

You run **two types of funnel** — a free lead-gen funnel and paid course sales:

```
FREE FUNNEL (current primary):
  Meta Ad → www.urbansketchcourse.com/courses/free-urban-sketch-course
         → www.urbansketchcourse.com/smm/urban-sketching-beginners-course/
         → www.urbansketchcourse.com/smm/landscape-sketching-course/
    → Registration Form: learn.urbansketch.com/reg/free-sketching-course-registration-form/
    → Free course registration (referral amount = £0.00)

PAID FUNNEL (landing page A/B testing):
  Meta Ad → go.urbansketchcourse.com/beginners-course/?a=36  ← THIS IS WHAT WE TEST
    → Order Form: learn.urbansketch.com/smm/buy-beginners-course/  (via Buy Now link)
    → Purchase (referral amount > £0.00)
```

### URL Domain Mapping (from real AffiliateWP API data)

AffiliateWP tracks visits across three domains. The data pull script classifies them:

| Domain | Type | Example Paths |
|--------|------|---------------|
| `go.urbansketchcourse.com` | Landing (static Cloudflare) | `/beginners-course/` |
| `www.urbansketchcourse.com` | Landing (WordPress) | `/courses/*`, `/smm/*`, `/world-sketcher-collection/` |
| `learn.urbansketch.com` | Order form / registration | `/reg/*`, `/smm/buy-*`, `/buy/*`, `/join-today/*` |

**Noise:** `www.urbansketchcourse.com/meta.json` — automated requests, ~74% of all www. visits. Filtered out by the script.

**learn. non-order pages:** T&C, privacy policy, student gallery, etc. are tracked but excluded from order form counts.

**Your optimisation zone is the landing page.** That's where the static pages live, where you control the copy, and where the A/B testing happens. The order form on WordPress is unchanged.

**Your primary metric is CTA click-through rate** — the percentage of landing page visitors who click through to an order/registration form (LP → Order Form rate from AffiliateWP).

**Your secondary metric is cost per lead/acquisition** — for free funnels, this is cost per registration. For paid funnels, this is CPA cross-referenced with AOV.

**Referral amounts:** Free course registrations show `amount = 0`. Paid course purchases show the actual sale amount. The script auto-detects the funnel type and adjusts its reporting accordingly.

### Monday Morning Prompt (Copy-Paste This Every Monday)

```
Monday CRO Analysis — Week of [DATE]

Run the full weekly analysis:
1. Pull AffiliateWP conversion data: node scripts/pull-affwp-data.js --days 7 --ad-spend [AMOUNT]
2. Pull Meta ad performance via GoMarble: campaign spend, CPC, CTR for the last 7 days
3. Query Clarity: scroll depth, engagement, dead clicks, rage clicks for last 3 days
4. If A/B test running: compare variants in Clarity custom tags
5. Apply the OfferNomics constraint identification (see framework below):
   - MEDIA: Is CPC in range? Is CTR solid? (GoMarble)
   - CAMPAIGN: Is LP→Order Form rate >3%? Where's the scroll drop-off? (AffiliateWP + Clarity)
   - ECONOMIC: Is CPA ≤ AOV? Revenue per visitor vs cost per visitor? (AffiliateWP + GoMarble)
6. Identify the single constraint and recommend the highest-ICE test for this week
7. If a test ended, declare winner and log in the test log below
```

Replace `[DATE]` with this Monday's date and `[AMOUNT]` with your Meta ad spend for the previous 7 days in GBP.

**Note:** If the GoMarble MCP server is connected (Meta access token set in .mcp.json), Claude will pull the ad spend automatically and you can omit the `--ad-spend` flag. If not yet connected, provide the spend manually.

### The Weekly Cycle

#### Phase 1: Monday Morning — Analyse (30-45 mins)

**Step 1: Pull the numbers (Claude does this automatically from the prompt)**

Three data sources, three layers:

| Layer | Source | What Claude Pulls |
|-------|--------|------------------|
| Media | GoMarble MCP | Spend, CPC, CTR, impressions, clicks per campaign |
| Campaign | AffiliateWP script + Clarity MCP | LP visits, OF visits, LP→OF rate, scroll depth, dead clicks |
| Economic | AffiliateWP script + GoMarble | CPA, AOV, revenue per visitor, CPA:AOV ratio |

**Step 2: If an A/B test is running — check the results**

In Clarity dashboard (clarity.microsoft.com):
1. Go to Filters > Custom Tags
2. Filter by your test name (e.g. `beginners-course`)
3. Set value to `control` — note the scroll depth, click map, engagement time
4. Set value to `variant-b` — note the same metrics
5. Compare side by side

Then check statistical significance:
- Go to https://abtestguide.com/calc/
- Enter: visitors per variant + conversions (CTA clicks) per variant
- If significant (p < 0.05): declare a winner, move to Phase 2
- If not significant: keep running, come back next Monday

**Step 3: If no test is running — diagnose the page**

In Clarity dashboard:
1. **Scroll depth map**: Where does the drop-off cliff happen? (The point where >50% of visitors have stopped scrolling.) That's your highest-impact optimisation target.
2. **Click maps**: Are visitors clicking the CTA buttons? Are they clicking things that aren't clickable (dead clicks)? Are they rage-clicking anything?
3. **Watch 5 recordings** of visitors who did NOT click Buy Now. Watch what they actually did. Where did they pause? Where did they leave?

Write down your diagnosis:
- "60% of visitors drop off before seeing the testimonials section"
- "Nobody clicks the first CTA — they scroll past it"
- "Visitors on mobile can't see the pricing clearly"

#### Phase 2: Monday — Decide What to Test (15 mins)

**Use ICE scoring** (from Bionic Business Issue #96):

For each observation from Phase 1, score:
- **Impact** (1-10): If this fix works, how much will CTA clicks increase?
- **Confidence** (1-10): How sure am I this will actually help?
- **Ease** (1-10): How fast can I implement and deploy this?

Pick the highest-scoring item. That's your test for this week.

**What to test (in priority order):**

1. **Headline** — biggest impact, test first. Completely different angle, not just word changes.
2. **Above-the-fold layout** — what visitors see before scrolling. Hero image, headline, sub-headline, first CTA.
3. **Social proof placement** — move testimonials higher if scroll drop-off happens before them.
4. **CTA copy and positioning** — different button text, different placement, add urgency.
5. **Section order** — reorder the page to put highest-impact content earlier.
6. **Copy length** — test a shorter page vs the current long-form page.

**Rule: Test ONE thing at a time.** If you change the headline AND the CTA AND the layout, you won't know what worked.

#### Phase 3: Monday/Tuesday — Build and Deploy the Variant (15-30 mins)

**Step 1: Create the variant**

```bash
cd ~/urban-sketch-landing-pages
cp beginners-course/index.html beginners-course/variant-b.html
```

**Step 2: Edit the variant**

Open `variant-b.html` and make your ONE change. Clarity script and link rewriting JS are already there (copied from index.html).

You can ask Claude to help with the copy. With your copywriting skills loaded (Clayton, Deutsch, Carlton, Evaldo), say something like:

```
"The current headline is [X]. Clarity shows 40% of visitors bounce before scrolling.
Write me 3 alternative headlines using Carlton's incongruous juxtaposition technique
that would stop a Facebook scroller and make them want to read more."
```

**Step 3: Activate the test**

Edit `_worker.js` — uncomment/update the `AB_TESTS` config:

```javascript
const AB_TESTS = {
  '/beginners-course/': {
    variants: [
      { name: 'control',   path: '/beginners-course/index.html',      weight: 50 },
      { name: 'variant-b', path: '/beginners-course/variant-b.html',  weight: 50 },
    ],
  },
};
```

**Step 4: Deploy**

```bash
git add . && git commit -m "Start test: [what you're testing]" && git push
```

**Step 5: Verify (2 mins)**

Open an incognito window, visit the page. Check DevTools > Application > Cookies for `ab_beginners-course`. Reload in a new incognito window to check you can get both variants.

#### Phase 4: Tuesday–Sunday — Let It Run

Do nothing. Do not peek at results mid-week and stop the test early. The test needs a full week of traffic to account for day-of-week patterns.

**Minimum requirements before calling a winner:**
- At least 7 days of data
- At least 100 visitors per variant (ideally 200+)
- Statistical significance at p < 0.05

#### Phase 5: Next Monday — Close the Loop

Back to Phase 1. Analyse the results.

**If the variant won:**
1. Replace `index.html` with the winning variant's content
2. Delete `variant-b.html`
3. Comment out the `AB_TESTS` entry
4. Commit: `"End test: [what won]. +X% CTA clicks"`
5. Push — the winner is now the new control
6. Start Phase 2 again with your next highest-ICE item

**If the control won:**
1. Delete `variant-b.html`
2. Comment out the `AB_TESTS` entry
3. Commit: `"End test: [what you tested]. Control won."`
4. Push
5. Your diagnosis was wrong OR the change wasn't big enough. Try a bolder change.

**If inconclusive (not enough data):**
- If close to significance: extend for another week
- If nowhere near significance: the difference is too small to matter. Pick a bolder test.

### Test Log

Keep a running log in this section of what you've tested and the results. This prevents re-testing things and builds institutional knowledge.

```
| Date       | Test                          | Variant | Result     | CTA Rate Change |
|------------|-------------------------------|---------|------------|-----------------|
| 2026-02-17 | Tracking system setup          | N/A     | Baseline   | Measuring...    |
| YYYY-MM-DD | [What you tested]             | B       | Won/Lost   | +X% / -X%      |
```

### Quarterly Review

Every 3 months, review your test log:
- What patterns are emerging? (e.g. "urgency headlines always win", "shorter pages convert better")
- What's your cumulative CTA rate improvement since you started?
- Are there diminishing returns? Time to test something bigger (different offer, different page structure, video vs no video)?
- Should you apply winning patterns to the other landing pages (Rural Sketch, Free Course)?

## Debugging

If tracking isn't working, temporarily add a debug endpoint to the worker. Add this block at the top of the `fetch()` handler, right after `const url = new URL(request.url);`:

```javascript
if (url.pathname === '/__debug') {
  const parentUrl = (env.AFFWP_PARENT_URL || '').replace(/\/$/, '');
  const publicKey = env.AFFWP_PUBLIC_KEY || '';
  const token = env.AFFWP_TOKEN || '';

  let apiTest = 'skipped';
  if (parentUrl && publicKey && token) {
    try {
      const testUrl = `${parentUrl}/wp-json/affwp/v1/visits?number=1`;
      const authHeader = 'Basic ' + btoa(`${publicKey}:${token}`);
      const resp = await fetch(testUrl, {
        headers: { 'Authorization': authHeader }
      });
      apiTest = `${resp.status} ${resp.statusText}`;
    } catch (e) {
      apiTest = `Error: ${e.message}`;
    }
  }

  return new Response(JSON.stringify({
    worker_running: true,
    env_vars: {
      AFFWP_PARENT_URL: parentUrl ? 'SET' : 'MISSING',
      AFFWP_PUBLIC_KEY: publicKey ? 'SET' : 'MISSING',
      AFFWP_TOKEN: token ? 'SET' : 'MISSING',
      AFFWP_REF_VAR: env.AFFWP_REF_VAR || 'MISSING (defaults to ref)',
      AFFWP_COOKIE_DAYS: env.AFFWP_COOKIE_DAYS || 'MISSING (defaults to 400)',
      AFFWP_CREDIT_LAST: env.AFFWP_CREDIT_LAST || 'MISSING (defaults to true)',
    },
    api_test: apiTest,
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
```

Visit `https://yourdomain.com/__debug` to check. **Remove this before going live.**

### Common Issues Checklist

| Symptom | Cause | Fix |
|---------|-------|-----|
| No cookies set at all | Worker not running | Check `run_worker_first: true` in wrangler.jsonc |
| Env vars missing after deploy | Dashboard vars wiped by wrangler.jsonc | Move vars into wrangler.jsonc `"vars"` section |
| API returns 401 | Wrong credentials | Re-set secrets via `wrangler pages secret put` |
| API returns 403 | API keys lack write permission | Generate new keys in AffiliateWP > Settings > REST API |
| Visit created but wrong affiliate | Affiliate ID mismatch | Check `?a=` value matches AffiliateWP affiliate ID |
| Links not rewritten on page | Client-side JS missing or wrong parentUrl | Check JS is present before `</body>`, parentUrl matches |
| `_worker.js` accessible as static file | Missing `.assetsignore` | Create `.assetsignore` with `_worker.js` |
| Cached stale responses during debugging | Cloudflare CDN cache | Append `?nocache=xxx` or purge cache in dashboard |
| A/B test always shows same variant | Cookie already set | Clear cookies or use incognito |
| Clarity not showing custom tags | Script loads after clarity() call | Ensure Clarity script is in `<head>` before `</head>` |
| Variant not loading | Wrong path in AB_TESTS config | Check path matches actual file location exactly |

## AffiliateWP API Reference

- **Base:** `https://learn.urbansketch.com/wp-json/affwp/v1/`
- **Auth:** HTTP Basic (`public_key:token`)
- **Create visit:** `POST /visits?affiliate_id=X&ip=X&url=X&campaign=X&referrer=X`
- **Get visits:** `GET /visits?number=100&orderby=date&order=DESC`
  - Filter params: `visit_id`, `affiliate_id`, `referral_id`, `referral_status`, `campaign`, `fields`
  - Response: `visit_id`, `affiliate_id`, `referral_id`, `url`, `referrer`, `campaign`, `ip`, `date`
- **Get referrals:** `GET /referrals?number=100&orderby=date&order=DESC`
  - Filter params: `referral_id`, `affiliate_id`, `reference`, `campaign`, `status` (paid/unpaid/pending/rejected), `date`, `fields`
  - Response: `referral_id`, `affiliate_id`, `visit_id`, `description`, `status`, `amount`, `currency`, `campaign`, `date`

---

## AffiliateWP Data Pull Script

A Node.js script that queries the AffiliateWP REST API and outputs a weekly CRO report with OfferNomics diagnosis.

### Setup (One-Time)

1. Copy your AffiliateWP API credentials from Cloudflare dashboard (Settings > Environment variables > Production) into `scripts/.env`:
   ```
   AFFWP_PARENT_URL=https://learn.urbansketch.com
   AFFWP_PUBLIC_KEY=your-key-here
   AFFWP_TOKEN=your-token-here
   ```

2. Requires Node.js 18+ (for built-in fetch). No npm install needed.

### Usage

```bash
# Basic — last 7 days, no ad spend calculation
node scripts/pull-affwp-data.js --days 7

# With ad spend — enables CPA, revenue per visitor, OfferNomics diagnosis
node scripts/pull-affwp-data.js --days 7 --ad-spend 500

# Last 14 days
node scripts/pull-affwp-data.js --days 14 --ad-spend 1000
```

### What It Reports

- **Raw data:** Total visits, noise filtered, visits by classification
- **Funnel metrics:** LP visits, order form visits, LP→OF click-through rate, registrations/sales, order form completion rate, end-to-end conversion
- **Financial metrics:** Revenue, CPA, AOV, revenue per visitor, cost per visitor, CPA:AOV ratio (paid funnels), cost per lead (free funnels)
- **OfferNomics diagnosis:** Identifies whether constraint is media, campaign, or economic
- **Breakdowns:** Visits by landing page URL, by campaign, by referrer domain, order form pages, and non-order-form learn.urbansketch.com pages

### How It Classifies Visits

The script classifies visits by hostname and path:

| Classification | Domain | Paths | Count (typical 7-day) |
|---------------|--------|-------|----------------------|
| `landing` | `go.urbansketchcourse.com` | all | ~20 |
| `landing` | `www.urbansketchcourse.com` | all except `/meta.json` | ~12,000 |
| `order_form` | `learn.urbansketch.com` | `/reg/*`, `/smm/buy-*`, `/buy/*`, `/join-today/*` | ~1,700 |
| `noise` | `www.urbansketchcourse.com` | `/meta.json` only | ~40,000 |
| `learn_other` | `learn.urbansketch.com` | everything else (T&C, privacy, etc.) | ~180 |
| `other` | any other domain | — | ~70 |

**Performance note:** AffiliateWP generates ~7,000 visits/day, mostly `/meta.json` noise. A 7-day query fetches ~54,000 records in ~109 API batches (~90 seconds). The max batch limit is 150 (75K visits). For periods >10 days, consider whether the run time is acceptable.

### Funnel Type Detection

The script auto-detects whether the current period is a free funnel, paid funnel, or mixed:
- **FREE funnel** — all referrals have `amount = 0`. Reports cost per lead instead of CPA.
- **PAID funnel** — all referrals have `amount > 0`. Reports CPA, AOV, CPA:AOV ratio.
- **MIXED** — both types present. Reports all metrics.

---

## GoMarble Meta Ads MCP Server

The GoMarble Facebook Ads MCP server gives Claude direct access to your Meta ad performance data — spend, CPC, CTR, creative breakdowns — without you having to manually look up numbers in Ads Manager.

### Setup (One-Time)

1. **Generate a Meta access token** with `ads_read` permission:
   - Go to https://developers.facebook.com/tools/explorer/
   - Select your app, then select `ads_read` permission
   - Generate a long-lived token
   - Or use GoMarble's installer: https://gomarble.ai/mcp

2. **Replace** `YOUR_META_ACCESS_TOKEN` in `.mcp.json` with your actual token.

3. **Restart Claude Code** to pick up the new MCP server.

### Token Expiry

The Meta access token expires every **60 days**. Current token was set on **17 Feb 2026** — expires around **18 Apr 2026**.

When it expires, GoMarble queries will fail with an auth error. To refresh:
1. Go to https://developers.facebook.com/tools/explorer/
2. Generate a new long-lived token with `ads_read` permission
3. Update the `--fb-token` value in `.mcp.json`
4. Restart Claude Code

### Available Tools

| Tool | What It Does |
|------|-------------|
| `list_ad_accounts` | Returns all ad accounts linked to your token |
| `get_campaign_insights` | Campaign spend, CPC, CTR, impressions, clicks for a date range |
| `get_adset_insights` | Per-adset performance breakdown |
| `get_ad_insights` | Per-ad performance (creative analysis) |
| `get_ad_creative_by_id` | Creative asset details |

### Example Queries (Ask Claude)

```
"What was my total Meta ad spend, average CPC, and CTR for the last 7 days?"
"Which campaigns had the highest CPA in the last 14 days?"
"Show me the top 5 performing ads by CTR this month"
"What's the spend breakdown by campaign for last week?"
```

### Python Environment

The server runs in its own Python 3.12 venv at `scripts/gomarble-mcp/venv/`. If you need to reinstall:

```bash
cd scripts/gomarble-mcp
/opt/homebrew/opt/python@3.12/bin/python3.12 -m venv venv
source venv/bin/activate
pip install mcp requests
```

---

## OfferNomics CRO Framework

From John Mulry's OfferNomics — a systematic constraint identification process for paid advertising. Every campaign has ONE weakest link. Find it, fix it, ignore everything else.

### The Three Performance Layers

```
1. MEDIA PERFORMANCE — Are the ads working?
   └─ Is CPC in range? Is CTR solid?
   └─ Source: GoMarble MCP (Meta Ads data)

2. CAMPAIGN PERFORMANCE — Are the pages converting?
   └─ Is LP → Order Form rate above 3%?
   └─ Where's the scroll drop-off?
   └─ Is order form completion above 60%?
   └─ Source: AffiliateWP script + Clarity MCP

3. ECONOMIC PERFORMANCE — Do the numbers work?
   └─ Is CPA ≤ AOV? (Level 2: breakeven)
   └─ What's revenue per visitor vs cost per visitor?
   └─ Source: AffiliateWP script + GoMarble spend
```

### Constraint Identification Flow

Always diagnose in this order. Fix the FIRST constraint you find:

```
Is cost per visitor in range?
  ├─ NO → Is targeting right? → Fix audience
  │       Is CTR solid (>1%)? → Fix creative (headline, hook, image)
  │       Both OK but CPC high? → Economic issue (see step 3)
  │
  └─ YES → Move to campaign performance

Is landing page converting (>3% to order form)?
  ├─ NO → Check Clarity scroll depth for drop-off point
  │       Drop-off in first screen? → Fix headline/above-the-fold
  │       Drop-off mid-page? → Fix copy/argument/proof section
  │       Drop-off before CTA? → Fix CTA placement/copy
  │
  └─ YES → Move to order form

Is order form completing (>60%)?
  ├─ NO → Simplify form fields
  │       Add trust signals, testimonials
  │       Test two-step checkout
  │       Check mobile rendering
  │
  └─ YES → Move to economics

Is CPA ≤ AOV?
  ├─ NO → ECONOMIC CONSTRAINT
  │       Phase 1: Add transaction maximisation offers (bumps, upsells)
  │       Phase 2: Optimise TMO conversion rates
  │       Phase 3: Test higher TMO prices
  │       Phase 4: Test higher core offer price (last resort)
  │       Phase 5: Lengthen monetisation window (multiple funnels, 30-day window)
  │
  └─ YES → No constraint! Scale ad spend and expand audiences
```

### Benchmarks

| Metric | Benchmark | Source |
|--------|-----------|--------|
| Link CTR (Meta ads) | >1% | GoMarble MCP |
| Cost per visitor | Varies by niche | GoMarble MCP |
| LP → Order Form rate | >3% | AffiliateWP visits |
| Order form completion | >60% | AffiliateWP referrals vs OF visits |
| Upsell take rate | >20% | WordPress backend |
| CPA ≤ AOV | Level 2: breakeven | AffiliateWP + GoMarble |
| Revenue per visitor > Cost per visitor | Viable | AffiliateWP ÷ LP visits vs GoMarble spend ÷ LP visits |

### Levels of Acquisition Aggression (LAA)

| Level | Name | Meaning |
|-------|------|---------|
| 1 | Mom & Pop | Profitable from day zero — won't spend more than they make |
| 2 | Breakeven | Willing to break even on frontend, profit on backend |
| 3 | Strategic | Willing to lose on frontend if LTV justifies it |
| 4 | Investor | Willing to invest significantly, looking at 30/60/90 day payback |

**Your current target: Level 2 (Breakeven)** — CPA ≤ AOV on day zero.
