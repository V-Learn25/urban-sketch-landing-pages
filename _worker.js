/**
 * Cloudflare Pages Worker - AffiliateWP Cross-Domain Tracker + A/B Testing
 *
 * Replicates the "child site" behaviour of the Cross Domain Tracker
 * for AffiliateWP plugin on static landing pages, and handles
 * edge-side A/B test routing with Microsoft Clarity tagging.
 *
 * Configuration (set in wrangler.jsonc vars + Cloudflare dashboard secrets):
 *   AFFWP_PARENT_URL    - e.g. https://learn.urbansketch.com  (vars)
 *   AFFWP_PUBLIC_KEY    - AffiliateWP REST API public key      (secret)
 *   AFFWP_TOKEN         - AffiliateWP REST API token           (secret)
 *   AFFWP_REF_VAR       - Referral variable name, default "ref" (vars)
 *   AFFWP_COOKIE_DAYS   - Cookie expiration in days, default 400 (vars)
 *   AFFWP_CREDIT_LAST   - "true" to overwrite existing referral (vars)
 *
 * A/B Testing:
 *   Configure tests in the AB_TESTS object below. Each test maps a
 *   URL path to a set of weighted variants. The worker assigns visitors
 *   via cookie and serves the correct variant using env.ASSETS.fetch().
 *   Variant names are automatically tagged in Microsoft Clarity via
 *   HTMLRewriter so you can filter heatmaps/recordings by variant.
 */

// ─────────────────────────────────────────────────────────────
// A/B TEST CONFIGURATION
//
// To add a test: add an entry to this object.
// To end a test: remove or comment out the entry.
// To change traffic split: adjust the weight values (must total 100).
//
// The 'control' variant should always point to index.html.
// Additional variants use separate HTML files in the same directory.
//
// Example with 3 variants:
//   '/beginners-course/': {
//     variants: [
//       { name: 'control',   path: '/beginners-course/index.html',      weight: 34 },
//       { name: 'variant-b', path: '/beginners-course/variant-b.html',  weight: 33 },
//       { name: 'variant-c', path: '/beginners-course/variant-c.html',  weight: 33 },
//     ],
//   },
// ─────────────────────────────────────────────────────────────
const AB_TESTS = {
  '/beginners-course/start/': {
    variants: [
      { name: 'control',   path: '/beginners-course/start/',          weight: 50 },
      { name: 'variant-b', path: '/beginners-course/start/variant-b', weight: 50 },
    ],
  },
};

// Cookie prefix for A/B test assignments
const AB_COOKIE_PREFIX = 'ab_';
// How long to remember a visitor's variant assignment (30 days)
const AB_COOKIE_MAX_AGE = 30 * 86400;

// ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cookies = parseCookies(request.headers.get('cookie') || '');

    // ── A/B Test Routing ────────────────────────────────────
    const abResult = resolveABTest(url, cookies);

    // Fetch the page — either the variant path or the original request
    let response;
    if (abResult) {
      // Serve the variant's HTML file from static assets
      const variantUrl = new URL(request.url);
      variantUrl.pathname = abResult.variant.path;
      response = await env.ASSETS.fetch(new Request(variantUrl, request));
    } else {
      response = await env.ASSETS.fetch(request);
    }

    // ── Determine if this is an HTML page ────────────────────
    const contentType = response.headers.get('content-type') || '';
    const pathname = url.pathname;
    const isHtmlContent = contentType.includes('text/html');
    const isHtmlPath = pathname.endsWith('/') || pathname.endsWith('.html') || pathname === '';
    const isHtml = isHtmlContent || isHtmlPath;

    // ── Affiliate Tracking ──────────────────────────────────
    const refVar = env.AFFWP_REF_VAR || 'ref';
    const affiliateId = url.searchParams.get(refVar);
    const campaign = url.searchParams.get('campaign') || '';
    const cookieDays = parseInt(env.AFFWP_COOKIE_DAYS || '400', 10);
    const creditLast = (env.AFFWP_CREDIT_LAST || 'true') === 'true';

    // Decide if we need to do any post-processing (affiliate cookies, AB cookies, variant tagging)
    const needsAffiliate = affiliateId && isHtml;
    const needsABCookie = abResult && abResult.isNew;
    const needsVariantTag = abResult && isHtml;

    // If nothing to do, return the response as-is
    if (!needsAffiliate && !needsABCookie && !needsVariantTag) {
      return response;
    }

    // We need a mutable response for cookies / HTMLRewriter
    let newResponse = new Response(response.body, response);

    // ── Set A/B cookie for new visitors ─────────────────────
    if (needsABCookie) {
      const cookieName = AB_COOKIE_PREFIX + abResult.testKey;
      newResponse.headers.append(
        'Set-Cookie',
        `${cookieName}=${abResult.variant.name}; Path=/; Max-Age=${AB_COOKIE_MAX_AGE}; SameSite=Lax`
      );
    }

    // ── Affiliate tracking: create visit + set cookies ──────
    if (needsAffiliate) {
      const existingAffiliate = cookies['affwp_affiliate_id'];
      const existingVisit = cookies['affwp_visit_id'];

      // Credit-last-referrer logic
      const shouldTrack = creditLast || !existingAffiliate || !existingVisit;

      if (shouldTrack) {
        const visitId = await createAffiliateVisit(request, url, env, affiliateId, campaign);

        const maxAge = cookieDays * 86400;
        const cookieOpts = `Path=/; Max-Age=${maxAge}; SameSite=Lax`;

        newResponse.headers.append(
          'Set-Cookie',
          `affwp_affiliate_id=${affiliateId}; ${cookieOpts}`
        );

        if (campaign) {
          newResponse.headers.append(
            'Set-Cookie',
            `affwp_campaign=${encodeURIComponent(campaign)}; ${cookieOpts}`
          );
        }

        if (visitId) {
          newResponse.headers.append(
            'Set-Cookie',
            `affwp_visit_id=${visitId}; ${cookieOpts}`
          );
        }
      }
    }

    // ── Inject Clarity variant tag via HTMLRewriter ──────────
    if (needsVariantTag) {
      const testKey = abResult.testKey;
      const variantName = abResult.variant.name;

      newResponse = new HTMLRewriter()
        .on('head', {
          element(element) {
            element.append(
              `\n<script>` +
              `window.__abTest="${testKey}";` +
              `window.__abVariant="${variantName}";` +
              `if(typeof clarity==="function"){clarity("set","${testKey}","${variantName}");}` +
              `</script>\n`,
              { html: true }
            );
          },
        })
        .transform(newResponse);
    }

    return newResponse;
  },
};


// ─────────────────────────────────────────────────────────────
// A/B TEST HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Check if the request URL matches an active A/B test.
 * Returns { testKey, variant, isNew } or null if no test applies.
 */
function resolveABTest(url, cookies) {
  // Normalise path: ensure trailing slash for directory URLs
  let testPath = url.pathname;
  if (!testPath.endsWith('/') && !testPath.includes('.')) {
    testPath += '/';
  }

  const testConfig = AB_TESTS[testPath];
  if (!testConfig) return null;

  // Derive a short key from the path for the cookie name
  // e.g. '/beginners-course/' -> 'beginners-course'
  const testKey = testPath.replace(/^\/|\/$/g, '').replace(/\//g, '-') || 'home';

  const cookieName = AB_COOKIE_PREFIX + testKey;
  const existingAssignment = cookies[cookieName];

  // Check if visitor already has a valid assignment
  if (existingAssignment) {
    const assigned = testConfig.variants.find(v => v.name === existingAssignment);
    if (assigned) {
      return { testKey, variant: assigned, isNew: false };
    }
  }

  // New visitor: weighted random assignment
  const rand = Math.random() * 100;
  let cumulative = 0;
  for (const variant of testConfig.variants) {
    cumulative += variant.weight;
    if (rand < cumulative) {
      return { testKey, variant, isNew: true };
    }
  }

  // Fallback to last variant
  return { testKey, variant: testConfig.variants[testConfig.variants.length - 1], isNew: true };
}


// ─────────────────────────────────────────────────────────────
// AFFILIATE TRACKING HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Create a visit via AffiliateWP REST API. Returns visit_id or null.
 */
async function createAffiliateVisit(request, url, env, affiliateId, campaign) {
  const parentUrl = (env.AFFWP_PARENT_URL || '').replace(/\/$/, '');
  const publicKey = env.AFFWP_PUBLIC_KEY || '';
  const token = env.AFFWP_TOKEN || '';

  if (!parentUrl || !publicKey || !token) {
    console.error('[AffWP] Missing environment variables - cannot track visit');
    return null;
  }

  const visitorIp = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || '0.0.0.0';

  const landingUrl = url.origin + url.pathname;
  const referrer = request.headers.get('referer') || '';

  try {
    const apiParams = new URLSearchParams({
      affiliate_id: affiliateId,
      ip: visitorIp,
      url: landingUrl,
      campaign: campaign,
      referrer: referrer,
    });

    const apiUrl = `${parentUrl}/wp-json/affwp/v1/visits?${apiParams.toString()}`;
    const authHeader = 'Basic ' + btoa(`${publicKey}:${token}`);

    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    });

    const responseText = await apiResponse.text();

    if (apiResponse.ok) {
      try {
        const data = JSON.parse(responseText);
        return data.visit_id || data.id || null;
      } catch (parseErr) {
        console.error('[AffWP] Failed to parse API response:', parseErr.message);
      }
    } else {
      console.error('[AffWP] API error:', apiResponse.status, responseText.substring(0, 300));
    }
  } catch (err) {
    console.error('[AffWP] API request failed:', err.message);
  }

  return null;
}


// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

/**
 * Parse a Cookie header string into a key-value object
 */
function parseCookies(cookieStr) {
  const cookies = {};
  if (!cookieStr) return cookies;
  cookieStr.split(';').forEach(pair => {
    const [name, ...rest] = pair.trim().split('=');
    if (name) {
      cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
    }
  });
  return cookies;
}
