// Cloudflare Pages Function: Server-side Facebook Conversion API
// POST /api/fb-event
// Receives events from client-side and forwards to Facebook CAPI

const PIXEL_ID = '453207863234417';
const ACCESS_TOKEN = 'EAARvx4CH24ABOxZAH1OkmG3BaPWMRQdgtnYHqYyXaHYSaSz2euiW4xFGybvwT5sUy0g7FFAzNldw2MLIu0qZAtZCeuCgZAZBjpONZCLEp4pzIqhhMTSQgfNOgtL9BatUGxpZB96U3JUGYroPSIkZAoyzofZCBF9Ngz7GqwiAknldpFuvl9ZB6MBvdCzxWZC7907dLD0UgZDZD';

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { event_name, event_source_url, user_agent, fbc, fbp, client_ip } = body;

    // Get the real client IP from Cloudflare headers
    const ip = client_ip || context.request.headers.get('CF-Connecting-IP') || '';

    const event_time = Math.floor(Date.now() / 1000);

    const payload = {
      data: [
        {
          event_name: event_name || 'PageView',
          event_time,
          event_source_url: event_source_url || '',
          action_source: 'website',
          user_data: {
            client_ip_address: ip,
            client_user_agent: user_agent || context.request.headers.get('User-Agent') || '',
            fbc: fbc || null,
            fbp: fbp || null,
          },
        },
      ],
    };

    // Remove null values from user_data
    Object.keys(payload.data[0].user_data).forEach(key => {
      if (payload.data[0].user_data[key] === null) {
        delete payload.data[0].user_data[key];
      }
    });

    const fbResponse = await fetch(
      `https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    const result = await fbResponse.json();

    return new Response(JSON.stringify({ success: true, fb_response: result }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
