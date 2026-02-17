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
 *   AFFWP_COOKIE_DAYS   - Cookie expiration in days (default: 400)
 *   AFFWP_CREDIT_LAST   - "true" to overwrite existing referral (default: "true")
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── DEBUG ENDPOINT (remove once tracking is confirmed working) ──
    if (url.pathname === '/__debug') {
      const parentUrl = (env.AFFWP_PARENT_URL || '').replace(/\/$/, '');
      const publicKey = env.AFFWP_PUBLIC_KEY || '';
      const token = env.AFFWP_TOKEN || '';

      const debug = {
        worker_running: true,
        timestamp: new Date().toISOString(),
        env_vars: {
          AFFWP_PARENT_URL: parentUrl ? '✓ SET' : '✗ MISSING',
          AFFWP_PUBLIC_KEY: publicKey ? '✓ SET (' + publicKey.substring(0, 6) + '...)' : '✗ MISSING',
          AFFWP_TOKEN: token ? '✓ SET (' + token.substring(0, 6) + '...)' : '✗ MISSING',
          AFFWP_REF_VAR: env.AFFWP_REF_VAR || 'ref (default)',
          AFFWP_COOKIE_DAYS: env.AFFWP_COOKIE_DAYS || '400 (default)',
          AFFWP_CREDIT_LAST: env.AFFWP_CREDIT_LAST || 'true (default)',
        },
        request_headers: {
          'cf-connecting-ip': request.headers.get('cf-connecting-ip'),
          'user-agent': request.headers.get('user-agent'),
          'cookie': request.headers.get('cookie') ? 'present' : 'none',
        },
        api_test: null,
        asset_fetch_test: null,
      };

      // Test API connectivity
      if (parentUrl && publicKey && token) {
        try {
          const authHeader = 'Basic ' + btoa(publicKey + ':' + token);
          const testUrl = parentUrl + '/wp-json/affwp/v1/visits?number=1';
          const testResp = await fetch(testUrl, {
            method: 'GET',
            headers: { 'Authorization': authHeader },
          });
          const testBody = await testResp.text();
          debug.api_test = {
            status: testResp.status,
            status_text: testResp.statusText,
            response_preview: testBody.substring(0, 500),
          };
        } catch (err) {
          debug.api_test = { error: err.message };
        }
      }

      // Test asset fetching (simulates what happens on a real page request)
      try {
        const testAssetUrl = new URL('/beginners-course/', url.origin);
        const testAssetReq = new Request(testAssetUrl.toString(), { method: 'GET' });
        const testAssetResp = await env.ASSETS.fetch(testAssetReq);
        const assetContentType = testAssetResp.headers.get('content-type') || 'NOT SET';
        const assetHeaders = {};
        testAssetResp.headers.forEach((val, key) => { assetHeaders[key] = val; });
        debug.asset_fetch_test = {
          requested_url: testAssetUrl.toString(),
          status: testAssetResp.status,
          content_type: assetContentType,
          all_headers: assetHeaders,
          is_html: assetContentType.includes('text/html'),
        };
      } catch (err) {
        debug.asset_fetch_test = { error: err.message };
      }

      return new Response(JSON.stringify(debug, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // ── END DEBUG ENDPOINT ──

    const refVar = env.AFFWP_REF_VAR || 'ref';
    const affiliateId = url.searchParams.get(refVar);
    const campaign = url.searchParams.get('campaign') || '';
    const cookieDays = parseInt(env.AFFWP_COOKIE_DAYS || '400', 10);
    const creditLast = (env.AFFWP_CREDIT_LAST || 'true') === 'true';

    // Pass through to static assets first
    const response = await env.ASSETS.fetch(request);

    // Determine if this is an HTML page request
    const contentType = response.headers.get('content-type') || '';
    const pathname = url.pathname;
    const isHtmlContent = contentType.includes('text/html');
    const isHtmlPath = pathname.endsWith('/') || pathname.endsWith('.html') || pathname === '';

    console.log('[AffWP] Request:', pathname, '| ref:', affiliateId, '| content-type:', contentType, '| isHtmlContent:', isHtmlContent, '| isHtmlPath:', isHtmlPath);

    // Only process tracking for HTML page requests with a ref parameter
    if (!affiliateId || (!isHtmlContent && !isHtmlPath)) {
      return response;
    }

    console.log('[AffWP] Tracking visit for affiliate:', affiliateId);

    // Check existing cookies
    const cookies = parseCookies(request.headers.get('cookie') || '');
    const existingAffiliate = cookies['affwp_affiliate_id'];
    const existingVisit = cookies['affwp_visit_id'];

    console.log('[AffWP] Existing cookies - affiliate:', existingAffiliate || 'none', '| visit:', existingVisit || 'none', '| creditLast:', creditLast);

    // Credit-last-referrer logic: if disabled and cookies exist, skip API call
    if (!creditLast && existingAffiliate && existingVisit) {
      console.log('[AffWP] Skipping - first referrer wins and cookies already set');
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
      console.error('[AffWP] MISSING environment variables - parentUrl:', !!parentUrl, '| publicKey:', !!publicKey, '| token:', !!token);
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

      console.log('[AffWP] API call to:', apiUrl.replace(/\?.*/, '?...'));
      console.log('[AffWP] API params - affiliate_id:', affiliateId, '| ip:', visitorIp, '| url:', landingUrl);

      const apiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: '',
      });

      const responseText = await apiResponse.text();
      console.log('[AffWP] API response status:', apiResponse.status, '| body:', responseText.substring(0, 300));

      if (apiResponse.ok) {
        try {
          const data = JSON.parse(responseText);
          visitId = data.visit_id || data.id || null;
          console.log('[AffWP] Visit created successfully - visit_id:', visitId);
        } catch (parseErr) {
          console.error('[AffWP] Failed to parse API response as JSON:', parseErr.message);
        }
      } else {
        console.error('[AffWP] API error:', apiResponse.status, responseText.substring(0, 300));
      }
    } catch (err) {
      console.error('[AffWP] API request failed:', err.message);
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

    console.log('[AffWP] Response sent with cookies - affiliate:', affiliateId, '| visit:', visitId, '| campaign:', campaign || 'none');

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
