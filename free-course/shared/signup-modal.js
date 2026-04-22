/* =============================================================
   SHARED SIGNUP MODAL — Free Course Variants
   Depends on window.VL_CONFIG being defined BEFORE this script
   loads. Expected shape:
     window.VL_CONFIG = {
       TURNSTILE_SITEKEY : '0x...',              // Cloudflare Turnstile site key (invisible widget)
       REGISTER_ENDPOINT : '/api/register',      // Same-origin proxy -> WP MU-plugin
       FALLBACK_REG_URL  : 'https://...',        // Safety-net manual registration URL
       LOGIN_URL_BASE    : 'https://learn.../wp-login.php',
       POST_SIGNUP_PATH  : '/...oto-1.../',      // WP path to redirect user to after auto-login
       FUNNEL_TAG        : 'free-course',        // Passed to WP + tracking events
       VARIANT           : 'a'                   // A/B variant label, surfaced in Lead events
     };

   Also depends on:
   - A modal markup block with id="signup-modal" matching the
     structure in smm-free-course/index.html (form with
     [data-signup-form], first_name + email inputs, .form-error,
     .form-loading, .welcome-back with [data-login-btn] +
     [data-reset-link]).
   - A 1x1 holder: <div id="vl-turnstile-global"> outside the
     modal so Turnstile can render with real layout at page load.
   - Cloudflare Turnstile api.js loaded in <head>:
     <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback&render=explicit" async defer></script>
   - fbq, sendCAPI, gtag — optional; fired on successful signup
     only (never on button click) if present.
   - Every CTA that should open the modal has [data-open-modal].
   ============================================================= */

(function () {
  'use strict';

  var VL = window.VL_CONFIG || {};

  /* ===== TURNSTILE =====
     Single invisible widget lives outside the modal so it has
     real 1x1 layout at page load. 0x0 / display:none parents
     cause Turnstile to fail silently. */
  var _turnstileWidgetId = null;
  var _turnstileToken    = null;
  var _turnstileReady    = false;
  var _pendingSubmitForm = null;

  function renderGlobalTurnstile () {
    if (_turnstileReady || !window.turnstile || typeof window.turnstile.render !== 'function') return;
    var holder = document.getElementById('vl-turnstile-global');
    if (!holder) return;
    var configured = VL.TURNSTILE_SITEKEY && VL.TURNSTILE_SITEKEY.indexOf('__REPLACE') !== 0;
    if (!configured) return;

    _turnstileWidgetId = window.turnstile.render(holder, {
      sitekey  : VL.TURNSTILE_SITEKEY,
      size     : 'invisible',
      callback : function (token) {
        _turnstileToken = token;
        if (_pendingSubmitForm) {
          var form = _pendingSubmitForm;
          _pendingSubmitForm = null;
          var email     = (form.querySelector('input[type="email"]').value || '').trim();
          var firstName = (form.querySelector('input[name="first_name"]') || {}).value || '';
          submitSignup(form, email, firstName.trim(), token);
        }
      },
      'expired-callback': function () { _turnstileToken = null; },
      'error-callback':   function () {
        _turnstileToken = null;
        if (_pendingSubmitForm) {
          var form = _pendingSubmitForm;
          _pendingSubmitForm = null;
          form.classList.remove('is-submitting');
          showError(form, 'Verification failed. Please try again.');
        }
      }
    });
    _turnstileReady = true;
  }

  // api.js calls this when it finishes loading.
  window.onloadTurnstileCallback = renderGlobalTurnstile;
  // Fallback: if api.js loaded before this script ran.
  document.addEventListener('DOMContentLoaded', renderGlobalTurnstile);
  // Safety retry for unusual script-load timing.
  setTimeout(renderGlobalTurnstile, 1500);

  /* ===== URL HELPERS ===== */
  function buildLoginUrl(destinationPath) {
    var dest = 'https://learn.urbansketch.com' + destinationPath;
    return VL.LOGIN_URL_BASE + '?redirect_to=' + encodeURIComponent(dest);
  }
  function buildResetUrl(destinationPath) {
    var dest = 'https://learn.urbansketch.com' + destinationPath;
    return VL.LOGIN_URL_BASE + '?action=lostpassword&redirect_to=' + encodeURIComponent(dest);
  }
  function readCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  /* ===== FORM STATE HELPERS ===== */
  function showError(form, message) {
    var box = form.querySelector('.form-error');
    while (box.firstChild) box.removeChild(box.firstChild);
    var msgEl = document.createElement('div');
    msgEl.textContent = message;
    box.appendChild(msgEl);

    if (VL.FALLBACK_REG_URL) {
      var fallback = document.createElement('div');
      fallback.className = 'form-error-fallback';
      var link = document.createElement('a');
      link.href = VL.FALLBACK_REG_URL;
      link.textContent = 'Having trouble? Register on our backup page instead →';
      link.rel = 'noopener';
      fallback.appendChild(link);
      box.appendChild(fallback);
    }
    box.classList.add('show');
  }
  function clearError(form) {
    var box = form.querySelector('.form-error');
    if (!box) return;
    box.textContent = '';
    box.classList.remove('show');
  }
  function showWelcomeBack(form, loginUrl, resetUrl) {
    form.querySelector('.form-fields').style.display = 'none';
    var wb = form.querySelector('.welcome-back');
    wb.querySelector('[data-login-btn]').setAttribute('href', loginUrl);
    wb.querySelector('[data-reset-link]').setAttribute('href', resetUrl);
    wb.classList.add('show');
    wb.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ===== SUBMIT FLOW ===== */
  function handleSignupSubmit(e) {
    e.preventDefault();
    var form = e.target;
    clearError(form);

    var firstNameEl = form.querySelector('input[name="first_name"]');
    var firstName   = firstNameEl ? (firstNameEl.value || '').trim() : '';
    if (firstNameEl && !firstName) {
      showError(form, 'Please enter your first name.');
      return;
    }

    var email = (form.querySelector('input[type="email"]').value || '').trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      showError(form, 'Please enter a valid email address.');
      return;
    }

    form.classList.add('is-submitting');

    var turnstileConfigured = VL.TURNSTILE_SITEKEY && VL.TURNSTILE_SITEKEY.indexOf('__REPLACE') !== 0;

    if (!turnstileConfigured) {
      submitSignup(form, email, firstName, '');
      return;
    }

    if (_turnstileToken) {
      submitSignup(form, email, firstName, _turnstileToken);
      return;
    }

    if (_turnstileReady && _turnstileWidgetId && window.turnstile) {
      _pendingSubmitForm = form;
      try {
        window.turnstile.execute(_turnstileWidgetId);
      } catch (err) {
        _pendingSubmitForm = null;
        form.classList.remove('is-submitting');
        showError(form, 'Verification failed to start. Please try again.');
      }
      return;
    }

    // Not ready yet — poll briefly then retry.
    _pendingSubmitForm = form;
    var waited = 0;
    var tick = setInterval(function () {
      waited += 150;
      if (!_turnstileReady) renderGlobalTurnstile();

      if (_turnstileReady && _turnstileWidgetId && window.turnstile) {
        clearInterval(tick);
        try {
          window.turnstile.execute(_turnstileWidgetId);
        } catch (err) {
          _pendingSubmitForm = null;
          form.classList.remove('is-submitting');
          showError(form, 'Verification failed. Please try again.');
        }
      } else if (waited >= 5000) {
        clearInterval(tick);
        _pendingSubmitForm = null;
        form.classList.remove('is-submitting');
        showError(form, 'Could not verify — please refresh and try again.');
      }
    }, 150);
  }

  function submitSignup(form, email, firstName, turnstileToken) {
    // Pull affiliate info from URL (?a= / ?ref=) or cookie. Cookies don't cross
    // domains, so we must POST the affiliate_id for the WP endpoint to credit AffiliateWP.
    var urlParams   = new URLSearchParams(window.location.search);
    var affiliateId = urlParams.get('a') || urlParams.get('ref') || readCookie('affwp_affiliate_id') || '';
    var campaign    = urlParams.get('campaign') || readCookie('affwp_campaign') || '';

    var payload = {
      email        : email,
      first_name   : firstName || '',
      turnstile    : turnstileToken,
      redirect_to  : VL.POST_SIGNUP_PATH,
      funnel_tag   : VL.FUNNEL_TAG,
      affiliate_id : affiliateId,
      campaign     : campaign
    };

    fetch(VL.REGISTER_ENDPOINT, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(payload)
    })
    .then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = JSON.parse(text); } catch (e) {}
        return { status: res.status, raw: text, body: body };
      });
    })
    .then(function (r) {
      form.classList.remove('is-submitting');
      try { console.log('[vl-signup] status=' + r.status, 'body=', r.body, 'raw=', r.raw); } catch (e) {}

      if (!r.body || r.body.ok !== true) {
        var msg =
          (r.body && r.body.error)   ? r.body.error   :
          (r.body && r.body.message) ? r.body.message :
          'Something went wrong. Please try again in a moment.';
        showError(form, msg);
        resetTurnstile();
        return;
      }

      if (r.body.existing) {
        showWelcomeBack(form, r.body.login_url, r.body.lost_url);
        return;
      }

      // Real signup — fire Lead events (never on button click).
      if (typeof window.fbq === 'function') {
        window.fbq('track', 'Lead', { content_name: VL.FUNNEL_TAG, variant: VL.VARIANT });
      }
      if (typeof window.sendCAPI === 'function') {
        window.sendCAPI('Lead');
      }
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'generate_lead', { content_name: VL.FUNNEL_TAG, variant: VL.VARIANT });
      }

      window.location.href = r.body.login_url;
    })
    .catch(function () {
      form.classList.remove('is-submitting');
      showError(form, 'We could not reach the server. Check your connection and try again.');
      resetTurnstile();
    });
  }

  function resetTurnstile() {
    if (_turnstileWidgetId && window.turnstile && typeof window.turnstile.reset === 'function') {
      try { window.turnstile.reset(_turnstileWidgetId); } catch (e) {}
    }
    _turnstileToken = null;
  }

  // Wire up every [data-signup-form] on the page.
  document.querySelectorAll('[data-signup-form]').forEach(function (form) {
    form.addEventListener('submit', handleSignupSubmit);
  });

  /* ===== MODAL OPEN/CLOSE ===== */
  var modal = document.getElementById('signup-modal');
  if (!modal) return;
  var lastFocused = null;

  function openModal(sourceBtn){
    lastFocused = sourceBtn || document.activeElement;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    // Focus the first-name input for immediate typing.
    setTimeout(function(){
      var input = modal.querySelector('input[name="first_name"]') || modal.querySelector('input[type="email"]');
      if (input) input.focus();
    }, 120);
  }

  function closeModal(){
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    var form = modal.querySelector('[data-signup-form]');
    if (form) clearError(form);
    if (lastFocused && typeof lastFocused.focus === 'function') {
      try { lastFocused.focus(); } catch(e){}
    }
  }

  document.querySelectorAll('[data-open-modal]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      openModal(btn);
    });
  });

  modal.querySelectorAll('[data-close-modal]').forEach(function(el){
    el.addEventListener('click', function(e){
      e.preventDefault();
      closeModal();
    });
  });

  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
  });

  window._vlCloseSignupModal = closeModal;
})();
