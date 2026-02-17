# Cloudflare Pages + AffiliateWP Cross-Domain Tracking + A/B Testing

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
  CLAUDE.md            - This file
  beginners-course/
    index.html         - Landing page (control) with Clarity + client-side link rewriting JS
    variant-b.html     - A/B test variant (when test is active)
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

### Using Clarity for CRO

The optimization loop:
1. Let traffic run for a few days
2. Check Clarity scroll depth maps — where do visitors stop scrolling?
3. Check click maps — are they clicking the CTA? Are they clicking non-clickable elements?
4. Watch 5-10 session recordings of visitors who did NOT click Buy Now — what happened?
5. Form a hypothesis about what to change
6. Create a variant and run an A/B test
7. Repeat

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
- **Get referrals:** `GET /referrals?number=100&orderby=date&order=DESC`
