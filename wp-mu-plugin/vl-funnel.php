<?php
/**
 * Plugin Name: V-Learn Funnel Registration Endpoint
 * Description: Service endpoint that lets an external landing page register users into LearnDash courses. Lives as a must-use plugin so it survives theme updates and can't be accidentally disabled.
 * Version:     1.0.0
 * Author:      V-Learn
 *
 * Location: /wp-content/mu-plugins/vl-funnel.php
 *
 * Exposes two endpoints:
 *   POST /wp-json/vl/v1/register           Accepts email + turnstile, creates user, enrols in course, returns one-time login URL.
 *   GET  /vl-auto-login?t=TOKEN&r=PATH     Redeems the one-time token, signs the user in, redirects to PATH.
 *
 * Design goals:
 *   - No theme dependency (survives theme updates and Elementor edits).
 *   - No LearnDash hook dependency (does not rely on learndash-registration-form-redirect filter).
 *   - Redirect destination is passed from the landing page per-funnel, not inferred from slugs.
 *   - Existing-email detection returns a friendly "log in" response, not a raw error.
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
// Update these three values after deploy and you're done.
// Everything else in this file is wiring.
// ---------------------------------------------------------------------------

// LearnDash course ID that a fresh free-course signup should be enrolled into.
// Find it in WP admin: Courses -> (hover on the course row) -> the number after post=
if ( ! defined( 'VL_FUNNEL_FREE_COURSE_ID' ) ) {
	define( 'VL_FUNNEL_FREE_COURSE_ID', 39746 );
}

// Cloudflare Turnstile site+secret. Create a free widget at https://dash.cloudflare.com/?to=/:account/turnstile
// Site key is also pasted into the landing page HTML. Secret is only ever on the server.
if ( ! defined( 'VL_FUNNEL_TURNSTILE_SECRET' ) ) {
	define( 'VL_FUNNEL_TURNSTILE_SECRET', '0x4AAAAAADA-Ijq-SH4-t5BqgSxACWT68gM' );
}

// Origins allowed to call the register endpoint via CORS.
// Keep this short and explicit. Anything not on this list is rejected at preflight.
if ( ! defined( 'VL_FUNNEL_ALLOWED_ORIGINS' ) ) {
	define( 'VL_FUNNEL_ALLOWED_ORIGINS', 'https://go.urbansketchcourse.com,https://urbansketchcourse.com,https://www.urbansketchcourse.com' );
}

// Default post-registration redirect if the landing page omits one.
if ( ! defined( 'VL_FUNNEL_DEFAULT_REDIRECT' ) ) {
	define( 'VL_FUNNEL_DEFAULT_REDIRECT', '/smm/free-course-oto-1-smm/' );
}

// Allow-list of redirect paths the landing page may request post-signup.
// Only paths under these prefixes are honoured. Anything else falls back to the default.
// Protects against open-redirect abuse.
if ( ! defined( 'VL_FUNNEL_ALLOWED_REDIRECT_PREFIXES' ) ) {
	define( 'VL_FUNNEL_ALLOWED_REDIRECT_PREFIXES', '/smm/,/products/,/courses/,/welcome/' );
}

// Per-IP rate limit: max registration attempts per hour.
if ( ! defined( 'VL_FUNNEL_RATE_LIMIT_PER_HOUR' ) ) {
	define( 'VL_FUNNEL_RATE_LIMIT_PER_HOUR', 10 );
}

// Token lifetime for the one-time auto-login link (seconds).
if ( ! defined( 'VL_FUNNEL_TOKEN_TTL' ) ) {
	define( 'VL_FUNNEL_TOKEN_TTL', 300 );
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
// WP's default REST CORS headers are too permissive and too generic. Replace them
// with our own allow-list so the endpoint only accepts calls from our landing pages.
// ---------------------------------------------------------------------------

add_action( 'rest_api_init', function () {
	remove_filter( 'rest_pre_serve_request', 'rest_send_cors_headers' );
	add_filter( 'rest_pre_serve_request', 'vl_funnel_cors_headers', 15 );
}, 15 );

// Also hook send_headers to cover the case where our REST handler returns a
// non-success status. rest_pre_serve_request is only reliably applied on 2xx;
// error paths sometimes bypass it or have their origin header stripped.
add_action( 'send_headers', 'vl_funnel_send_cors_headers_early' );

function vl_funnel_send_cors_headers_early() {
	// Only emit for our REST route, not every WP request.
	$uri = isset( $_SERVER['REQUEST_URI'] ) ? $_SERVER['REQUEST_URI'] : '';
	if ( strpos( $uri, '/wp-json/vl/v1/' ) === false ) {
		return;
	}
	vl_funnel_emit_cors_headers();
}

function vl_funnel_emit_cors_headers() {
	$origin  = isset( $_SERVER['HTTP_ORIGIN'] ) ? $_SERVER['HTTP_ORIGIN'] : '';
	$allowed = array_map( 'trim', explode( ',', VL_FUNNEL_ALLOWED_ORIGINS ) );

	if ( $origin && in_array( $origin, $allowed, true ) ) {
		header( 'Access-Control-Allow-Origin: ' . $origin );
		header( 'Vary: Origin' );
		header( 'Access-Control-Allow-Methods: POST, OPTIONS' );
		header( 'Access-Control-Allow-Headers: Content-Type' );
		header( 'Access-Control-Max-Age: 600' );
	}
}

function vl_funnel_cors_headers( $value ) {
	vl_funnel_emit_cors_headers();
	return $value;
}

// ---------------------------------------------------------------------------
// ROUTE REGISTRATION
// ---------------------------------------------------------------------------

add_action( 'rest_api_init', function () {
	register_rest_route( 'vl/v1', '/register', array(
		'methods'             => 'POST',
		'callback'            => 'vl_funnel_handle_register',
		'permission_callback' => '__return_true',
		'args'                => array(
			'email'          => array( 'required' => true, 'type' => 'string' ),
			'turnstile'      => array( 'required' => false, 'type' => 'string' ),
			'redirect_to'    => array( 'required' => false, 'type' => 'string' ),
			'first_name'     => array( 'required' => false, 'type' => 'string' ),
			'funnel_tag'     => array( 'required' => false, 'type' => 'string' ),
		),
	) );
} );

// Public pretty URL /vl-auto-login?t=...&r=... — handled via template_redirect.
add_action( 'init', function () {
	add_rewrite_rule( '^vl-auto-login/?$', 'index.php?vl_auto_login=1', 'top' );
} );
add_filter( 'query_vars', function ( $v ) { $v[] = 'vl_auto_login'; return $v; } );
add_action( 'template_redirect', 'vl_funnel_handle_auto_login' );

// ---------------------------------------------------------------------------
// REGISTER ENDPOINT
// ---------------------------------------------------------------------------

function vl_funnel_handle_register( WP_REST_Request $request ) {
	// 0. Emit CORS headers defensively — some hosts/CDNs strip them on non-2xx responses.
	vl_funnel_emit_cors_headers();

	// 1. Rate limit by IP. Hard block before we touch the DB.
	$ip_key = 'vl_funnel_rate_' . md5( vl_funnel_client_ip() );
	$count  = (int) get_transient( $ip_key );
	if ( $count >= VL_FUNNEL_RATE_LIMIT_PER_HOUR ) {
		return new WP_REST_Response( array(
			'ok'    => false,
			'code'  => 'rate_limited',
			'error' => 'Too many attempts. Please wait a few minutes and try again.',
		), 429 );
	}
	set_transient( $ip_key, $count + 1, HOUR_IN_SECONDS );

	// 2. Turnstile verification (skipped only if the secret is blank, e.g. during local testing).
	if ( VL_FUNNEL_TURNSTILE_SECRET ) {
		$token = (string) $request->get_param( 'turnstile' );
		if ( ! vl_funnel_verify_turnstile( $token ) ) {
			return new WP_REST_Response( array(
				'ok'    => false,
				'code'  => 'turnstile_failed',
				'error' => 'Captcha check failed. Please refresh the page and try again.',
			), 400 );
		}
	}

	// 3. Email validation.
	$email = strtolower( trim( (string) $request->get_param( 'email' ) ) );
	if ( ! is_email( $email ) ) {
		return new WP_REST_Response( array(
			'ok'    => false,
			'code'  => 'invalid_email',
			'error' => 'Please enter a valid email address.',
		), 400 );
	}

	// 4. Redirect sanitization. Only allow paths under the configured prefixes.
	$redirect_to = (string) $request->get_param( 'redirect_to' );
	$redirect_to = vl_funnel_sanitize_redirect( $redirect_to );

	// 5. Existing-user short-circuit: show friendly "log in" response, not an error.
	if ( $existing = get_user_by( 'email', $email ) ) {
		$login_url = add_query_arg( array(
			'redirect_to' => rawurlencode( home_url( $redirect_to ) ),
		), wp_login_url() );

		$lost_url = add_query_arg( array(
			'action'      => 'lostpassword',
			'redirect_to' => rawurlencode( home_url( $redirect_to ) ),
		), wp_login_url() );

		return new WP_REST_Response( array(
			'ok'        => true,
			'existing'  => true,
			'login_url' => esc_url_raw( $login_url ),
			'lost_url'  => esc_url_raw( $lost_url ),
			'message'   => 'You are already registered. Log in to pick up where you left off.',
		), 200 );
	}

	// 6. Create the user. Auto-generate a password; they can change it later.
	// Suppress WordPress core's default new-user notification emails — they send
	// synchronously via wp_mail() on a broken mail pipe and add 10-30s to the
	// response. LearnDash sends its own branded welcome via arpReach anyway.
	if ( ! defined( 'VL_FUNNEL_SUPPRESS_NEW_USER_NOTIFY' ) ) {
		define( 'VL_FUNNEL_SUPPRESS_NEW_USER_NOTIFY', true );
	}
	add_filter( 'pre_wp_mail', 'vl_funnel_block_new_user_emails', 10, 2 );

	$first_name = sanitize_text_field( (string) $request->get_param( 'first_name' ) );
	$username   = vl_funnel_generate_username( $email );
	$password   = wp_generate_password( 16, true, false );

	$user_id = wp_insert_user( array(
		'user_login'   => $username,
		'user_email'   => $email,
		'user_pass'    => $password,
		'first_name'   => $first_name,
		'display_name' => $first_name ? $first_name : $username,
		'role'         => 'subscriber',
	) );

	remove_filter( 'pre_wp_mail', 'vl_funnel_block_new_user_emails', 10 );

	if ( is_wp_error( $user_id ) ) {
		return new WP_REST_Response( array(
			'ok'    => false,
			'code'  => 'user_create_failed',
			'error' => 'We could not create your account. Please try again or email support@urbansketch.com.',
		), 500 );
	}

	// 7. Enrol into the LearnDash course.
	if ( VL_FUNNEL_FREE_COURSE_ID && function_exists( 'ld_update_course_access' ) ) {
		ld_update_course_access( $user_id, VL_FUNNEL_FREE_COURSE_ID, false );
	}

	// 8. AffiliateWP referral crediting. Cross-origin landing page (go.urbansketchcourse.com)
	//    can't send learn.urbansketch.com cookies, so we accept the affiliate_id as a POST field.
	//    Fall back to the cookie if present (for same-origin future use).
	//    Further fallback: if a funnel_tag is present we're on a paid funnel, so default to
	//    affiliate_id=36 (FBAds) so a missing cookie/param never silently drops attribution.
	$funnel_tag = sanitize_key( (string) $request->get_param( 'funnel_tag' ) );

	$affwp_raw_param = $request->get_param( 'affiliate_id' );
	error_log( '[vl-funnel] register: email=' . $email . ' funnel_tag=' . $funnel_tag . ' affiliate_id_param=' . var_export( $affwp_raw_param, true ) . ' cookie_affwp_ref=' . ( isset( $_COOKIE['affwp_ref'] ) ? $_COOKIE['affwp_ref'] : 'none' ) );

	if ( function_exists( 'affiliate_wp' ) ) {
		$affiliate_id = absint( $affwp_raw_param );
		if ( ! $affiliate_id && ! empty( $_COOKIE['affwp_ref'] ) ) {
			$affiliate_id = absint( $_COOKIE['affwp_ref'] );
			error_log( '[vl-funnel] using cookie affwp_ref affiliate_id=' . $affiliate_id );
		}
		// Fallback: any tagged funnel submission on go.urbansketchcourse.com came through paid,
		// so credit FBAds (affiliate_id=36) even when the cookie/param made it through.
		if ( ! $affiliate_id && $funnel_tag ) {
			$affiliate_id = 36;
			error_log( '[vl-funnel] FALLBACK: no affiliate_id, using default 36 for funnel_tag=' . $funnel_tag );
		}

		if ( ! $affiliate_id ) {
			error_log( '[vl-funnel] SKIP referral: no affiliate_id resolvable (email=' . $email . ')' );
		} elseif ( ! affiliate_wp()->affiliates->get_affiliate( $affiliate_id ) ) {
			error_log( '[vl-funnel] SKIP referral: affiliate_id=' . $affiliate_id . ' not found in AffiliateWP (email=' . $email . ')' );
		} else {
			$referral_result = affiliate_wp()->referrals->add( array(
				'affiliate_id' => $affiliate_id,
				'amount'       => 0,
				'description'  => 'SMM Free Course Signup: ' . $email,
				'reference'    => $user_id,
				'context'      => 'vl_funnel_registration',
				'status'       => 'unpaid',
			) );
			error_log( '[vl-funnel] referrals->add returned: ' . var_export( $referral_result, true ) . ' (email=' . $email . ', affiliate_id=' . $affiliate_id . ')' );
		}
	} else {
		error_log( '[vl-funnel] SKIP referral: affiliate_wp() function not available (email=' . $email . ')' );
	}

	// 9. Tag the user with funnel metadata for later analytics.
	update_user_meta( $user_id, 'vl_funnel_source', $funnel_tag ? $funnel_tag : 'smm-free-course' );
	update_user_meta( $user_id, 'vl_funnel_signup_at', current_time( 'mysql' ) );

	// 9b. Stash the plaintext password so the [vl_credentials] shortcode can show
	//     it on the post-signup OTO page. Expires after 15 minutes (or immediately
	//     on first display) so it's never readable again after the initial view.
	update_user_meta( $user_id, '_vl_funnel_initial_password', $password );
	update_user_meta( $user_id, '_vl_funnel_initial_password_expires', time() + 15 * MINUTE_IN_SECONDS );

	// 10. Generate a one-time auto-login token.
	$token = wp_generate_password( 32, false, false );
	set_transient( 'vl_funnel_login_' . $token, array(
		'user_id'     => $user_id,
		'redirect_to' => $redirect_to,
	), VL_FUNNEL_TOKEN_TTL );

	$login_url = add_query_arg( array(
		't' => $token,
		'r' => rawurlencode( $redirect_to ),
	), home_url( '/vl-auto-login' ) );

	// 11. Welcome email is handled by LearnDash → arpReach. We used to call
	//     vl_funnel_send_welcome_email() here but wp_mail() is non-functional on
	//     this host and was adding 10-30s to every signup waiting for SMTP timeout.
	//     Kept the function definition below in case a future host restores wp_mail.

	return new WP_REST_Response( array(
		'ok'        => true,
		'existing'  => false,
		'login_url' => esc_url_raw( $login_url ),
	), 200 );
}

// ---------------------------------------------------------------------------
// AUTO-LOGIN ENDPOINT
// ---------------------------------------------------------------------------

function vl_funnel_handle_auto_login() {
	if ( ! get_query_var( 'vl_auto_login' ) ) return;

	$token = isset( $_GET['t'] ) ? sanitize_text_field( $_GET['t'] ) : '';
	$r     = isset( $_GET['r'] ) ? wp_unslash( $_GET['r'] ) : '';

	if ( ! $token ) {
		wp_safe_redirect( home_url( '/' ) );
		exit;
	}

	$key     = 'vl_funnel_login_' . $token;
	$payload = get_transient( $key );
	delete_transient( $key ); // one-time use

	if ( ! $payload || empty( $payload['user_id'] ) ) {
		// Expired or already-used token. Send them to the login page with the intended destination preserved.
		$fallback = vl_funnel_sanitize_redirect( $r ? $r : VL_FUNNEL_DEFAULT_REDIRECT );
		wp_safe_redirect( add_query_arg( 'redirect_to', rawurlencode( home_url( $fallback ) ), wp_login_url() ) );
		exit;
	}

	$user_id     = (int) $payload['user_id'];
	$redirect_to = vl_funnel_sanitize_redirect( $r ? $r : $payload['redirect_to'] );

	wp_clear_auth_cookie();
	wp_set_current_user( $user_id );
	wp_set_auth_cookie( $user_id, true );

	wp_safe_redirect( home_url( $redirect_to ) );
	exit;
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function vl_funnel_client_ip() {
	foreach ( array( 'HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR' ) as $h ) {
		if ( ! empty( $_SERVER[ $h ] ) ) {
			$ip = explode( ',', $_SERVER[ $h ] )[0];
			return trim( $ip );
		}
	}
	return '0.0.0.0';
}

function vl_funnel_verify_turnstile( $token ) {
	if ( ! $token ) return false;

	// NOTE: We intentionally do NOT send `remoteip` to Turnstile. The request reaches
	// this endpoint via a Cloudflare Worker proxy, so vl_funnel_client_ip() returns
	// the Worker's outbound IP rather than the browser's IP that Turnstile issued the
	// token against. Sending a mismatched remoteip causes Turnstile to reject otherwise
	// valid tokens. The token itself is a cryptographically signed proof of solve;
	// IP cross-check was a secondary layer we can safely omit.
	$resp = wp_remote_post( 'https://challenges.cloudflare.com/turnstile/v0/siteverify', array(
		'timeout' => 8,
		'body'    => array(
			'secret'   => VL_FUNNEL_TURNSTILE_SECRET,
			'response' => $token,
		),
	) );

	if ( is_wp_error( $resp ) ) return false;

	$body = json_decode( wp_remote_retrieve_body( $resp ), true );
	return ! empty( $body['success'] );
}

function vl_funnel_sanitize_redirect( $path ) {
	$path = (string) $path;

	// If a full URL was passed, strip it down to the path.
	if ( preg_match( '#^https?://#i', $path ) ) {
		$parsed = wp_parse_url( $path );
		$path   = isset( $parsed['path'] ) ? $parsed['path'] : '';
	}

	if ( ! $path || $path[0] !== '/' ) {
		return VL_FUNNEL_DEFAULT_REDIRECT;
	}

	$allowed = array_map( 'trim', explode( ',', VL_FUNNEL_ALLOWED_REDIRECT_PREFIXES ) );
	foreach ( $allowed as $prefix ) {
		if ( $prefix && strpos( $path, $prefix ) === 0 ) {
			return $path;
		}
	}

	return VL_FUNNEL_DEFAULT_REDIRECT;
}

/**
 * Short-circuit wp_mail() during wp_insert_user() so WordPress's blocking
 * new-user notifications never fire on this broken mail pipe. Only active
 * during the brief window between add_filter / remove_filter in the handler.
 * Returning `true` from `pre_wp_mail` tells WP the mail was handled (but we
 * just swallow it).
 */
function vl_funnel_block_new_user_emails( $short_circuit, $atts ) {
	return defined( 'VL_FUNNEL_SUPPRESS_NEW_USER_NOTIFY' ) && VL_FUNNEL_SUPPRESS_NEW_USER_NOTIFY ? true : $short_circuit;
}

function vl_funnel_generate_username( $email ) {
	$base = sanitize_user( current( explode( '@', $email ) ), true );
	if ( ! $base ) $base = 'student';
	$candidate = $base;
	$i         = 1;
	while ( username_exists( $candidate ) ) {
		$candidate = $base . $i;
		$i++;
	}
	return $candidate;
}

function vl_funnel_send_welcome_email( $email, $first_name, $username, $password, $destination_url ) {
	$name    = $first_name ? $first_name : 'there';
	$site    = get_bloginfo( 'name' );
	$login   = wp_login_url();

	$subject = 'Your free Urban Sketching course is ready';

	$body  = "Hi {$name},\n\n";
	$body .= "Welcome aboard. Your free course is ready to go.\n\n";
	$body .= "Jump straight in:\n{$destination_url}\n\n";
	$body .= "If you ever log out, your account details are:\n";
	$body .= "Username: {$username}\n";
	$body .= "Password: {$password}\n";
	$body .= "Login page: {$login}\n\n";
	$body .= "You can change your password any time from your account page.\n\n";
	$body .= "See you inside,\nThe {$site} team\n";

	wp_mail( $email, $subject, $body );
}

// ---------------------------------------------------------------------------
// ACTIVATION: flush rewrite rules once so /vl-auto-login resolves.
// Because this is an MU-plugin there's no activation hook, so we flush on first hit
// if the rule isn't present.
// ---------------------------------------------------------------------------

add_action( 'init', function () {
	$opt = get_option( 'vl_funnel_rewrite_version' );
	if ( $opt !== '1' ) {
		flush_rewrite_rules( false );
		update_option( 'vl_funnel_rewrite_version', '1', false );
	}
}, 99 );

// ---------------------------------------------------------------------------
// CREDENTIALS SHORTCODE
// ---------------------------------------------------------------------------
// Drop [vl_credentials] on any WordPress page to show the freshly-signed-up
// user their username + password once. Self-destructs after first display or
// after 15 minutes, whichever comes first. Renders nothing for anonymous
// visitors or returning users who've already seen it.
// ---------------------------------------------------------------------------

add_shortcode( 'vl_credentials', 'vl_funnel_credentials_shortcode' );

function vl_funnel_credentials_shortcode( $atts = array() ) {
	if ( ! is_user_logged_in() ) {
		return '';
	}

	$user_id = get_current_user_id();
	$password = get_user_meta( $user_id, '_vl_funnel_initial_password', true );
	$expires  = (int) get_user_meta( $user_id, '_vl_funnel_initial_password_expires', true );

	if ( ! $password ) {
		return '';
	}

	// Expired — clean up and render nothing.
	if ( $expires && time() > $expires ) {
		delete_user_meta( $user_id, '_vl_funnel_initial_password' );
		delete_user_meta( $user_id, '_vl_funnel_initial_password_expires' );
		return '';
	}

	$user       = wp_get_current_user();
	$username   = $user ? $user->user_login : '';
	$first_name = $user ? $user->first_name : '';
	$greeting   = $first_name ? esc_html( $first_name ) : 'there';

	// One-time read: delete both keys now so a page refresh doesn't re-show it.
	delete_user_meta( $user_id, '_vl_funnel_initial_password' );
	delete_user_meta( $user_id, '_vl_funnel_initial_password_expires' );

	ob_start();
	?>
	<div class="vl-credentials-card" style="max-width:680px;margin:1.5em auto;padding:1.5em 1.75em;border:1px solid #e5d7b5;background:#fffaf0;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.04);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
		<h3 style="margin:0 0 .6em;font-size:1.3em;color:#1a1a1a;">
			&#127881; You&rsquo;re in, <?php echo $greeting; ?>!
		</h3>
		<p style="margin:0 0 1em;color:#444;line-height:1.5;">
			Save these login details somewhere safe &mdash; you&rsquo;ll need them next time you return to the site.
			<strong>This is the only time you&rsquo;ll see your password on this page.</strong>
		</p>
		<div style="display:grid;grid-template-columns:max-content 1fr;gap:.5em 1.2em;margin:1em 0;padding:1em 1.2em;background:#fff;border:1px solid #e8e2d0;border-radius:6px;font-family:'Menlo','Monaco',monospace;font-size:.95em;">
			<strong style="color:#666;font-family:-apple-system,sans-serif;">Username</strong>
			<span style="user-select:all;color:#1a1a1a;"><?php echo esc_html( $username ); ?></span>
			<strong style="color:#666;font-family:-apple-system,sans-serif;">Password</strong>
			<span style="user-select:all;color:#1a1a1a;"><?php echo esc_html( $password ); ?></span>
		</div>
		<p style="margin:0 0 1.4em;color:#666;font-size:.9em;line-height:1.5;">
			Prefer your own password? You can change it any time from your account page once you&rsquo;re inside.
		</p>

		<div style="padding-top:1.3em;border-top:1px dashed #e5d7b5;text-align:center;">
			<p style="margin:0 0 .4em;font-size:1.05em;font-weight:700;color:#1a1a1a;letter-spacing:.02em;">
				Got them saved? Good. Now read the rest of this page.
			</p>
			<p style="margin:0 0 .8em;color:#555;font-size:.95em;line-height:1.55;">
				We&rsquo;ve put a new-student-only welcome below that&rsquo;s only available
				<strong>right now, on this page</strong>. Your first lesson will be
				waiting when you&rsquo;re done.
			</p>
			<div style="font-size:1.6em;color:#b8860b;line-height:1;animation:vlBounce 1.6s ease-in-out infinite;">&darr;</div>
		</div>
	</div>
	<style>
		@keyframes vlBounce {
			0%, 100% { transform: translateY(0); }
			50%      { transform: translateY(8px); }
		}
	</style>
	<?php
	return ob_get_clean();
}
