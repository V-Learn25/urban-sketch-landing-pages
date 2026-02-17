/**
 * Cloudflare Pages Worker - AffiliateWP Cross-Domain Tracker
 *
 * Replicates the "child site" behaviour of the Cross Domain Tracker
 * for AffiliateWP plugin on static landing pages.
 *
 * Environment variables (set as secrets in Cloudflare dashboard):
 *   AFFWP_PARENT_URL    - e.g. https://learn.urbansketch.com
 *   AFFWP_PUBLIC_KEY    - AffiliateWP REST API public key
 *   AFFWP_TOKEN         - AffiliateWP REST API token
 *   AFFWP_REF_VAR       - Referral variable name (default: "ref")
 *   AFFWP_COOKIE_DAYS   - Cookie expiration in days (default: 30)
 *   AFFWP_CREDIT_LAST   - "true" to overwrite existing referral (default: "true")
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const refVar = env.AFFWP_REF_VAR || 'ref';
    const affiliateId = url.searchParams.get(refVar);
    const campaign = url.searchParams.get('campaign') || '';
    const cookieDays = parseInt(env.AFFWP_COOKIE_DAYS || '30', 10);
    const creditLast = (env.AFFWP_CREDIT_LAST || 'true') === 'true';

    // Pass through to static assets first
    const response = await env.ASSETS.fetch(request);

    // Only process tracking for HTML page requests with a ref parameter
    if (!affiliateId || !response.headers.get('content-type')?.includes('text/html')) {
      return response;
    }

    // Check existing cookies
    const cookies = parseCookies(request.headers.get('cookie') || '');
    const existingAffiliate = cookies['affwp_affiliate_id'];
    const existingVisit = cookies['affwp_visit_id'];

    // Credit-last-referrer logic: if disabled and cookies exist, skip API call
    if (!creditLast && existingAffiliate && existingVisit) {
      return response;
    }

    // Get visitor IP
    const visitorIp = request.headers.get('cf-connecting-ip')
      || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || '0.0.0.0';

    // Build the landing page URL (without query string)
    const landingUrl = url.origin + url.pathname;

    // Get referrer
    const referrer = request.headers.get('referer') || '';

    // Create visit via AffiliateWP REST API
    const parentUrl = (env.AFFWP_PARENT_URL || '').replace(/\/$/, '');
    const publicKey = env.AFFWP_PUBLIC_KEY || '';
    const token = env.AFFWP_TOKEN || '';

    if (!parentUrl || !publicKey || !token) {
      console.error('AffiliateWP tracking: Missing environment variables');
      return response;
    }

    let visitId = null;

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

      if (apiResponse.ok) {
        const data = await apiResponse.json();
        visitId = data.visit_id || data.id || null;
      } else {
        console.error('AffiliateWP API error:', apiResponse.status, await apiResponse.text());
      }
    } catch (err) {
      console.error('AffiliateWP API request failed:', err.message);
    }

    // Build new response with tracking cookies
    const newResponse = new Response(response.body, response);
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

    return newResponse;
  },
};

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
