// netlify/functions/auth-callback.js
// Handles the Auth0 redirect after login.
// Exchanges the authorization code for tokens, sets a secure HttpOnly
// session cookie, detects admin role, and routes accordingly.

const crypto   = require('crypto');
const { supabase } = require('./_db');
const notify       = require('./_notify');

const {
  AUTH0_DOMAIN,
  AUTH0_CLIENT_ID,
  AUTH0_CLIENT_SECRET,
  AUTH0_COOKIE_SECRET,
  URL: SITE_URL,
} = process.env;

const COOKIE_NAME     = 'apex_session';
const MAX_AGE_SECONDS = 60 * 60 * 8; // 8 hours
const ROLES_CLAIM     = 'https://apexcapital.com/roles';

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const { code, error, error_description } = params;

  if (error) {
    console.error('Auth0 error:', error, error_description);
    return redirect('/?auth_error=' + encodeURIComponent(error_description || error));
  }
  if (!code) return redirect('/?auth_error=missing_code');

  const ip        = event.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const userAgent = event.headers['user-agent'] || 'unknown';

  try {
    // 1. Exchange code for tokens
    const tokenRes = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type:    'authorization_code',
        client_id:     AUTH0_CLIENT_ID,
        client_secret: AUTH0_CLIENT_SECRET,
        code,
        redirect_uri:  `${SITE_URL}/.netlify/functions/auth-callback`,
      }),
    });

    if (!tokenRes.ok) {
      console.error('Token exchange failed:', await tokenRes.text());
      return redirect('/?auth_error=token_exchange_failed');
    }

    const { access_token } = await tokenRes.json();

    // 2. Fetch Auth0 user profile (includes custom claims if action is configured)
    const userRes = await fetch(`https://${AUTH0_DOMAIN}/userinfo`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const user = await userRes.json();

    const name    = user.name || user.nickname || user.email;
    const email   = user.email;
    const sub     = user.sub;

    // 3. Read Auth0 roles from custom namespace claim.
    //
    //    SETUP (one-time in Auth0 dashboard):
    //    → Actions → Flows → Login → Create action with this code:
    //
    //    exports.onExecutePostLogin = async (event, api) => {
    //      const ns = 'https://apexcapital.com/roles';
    //      api.idToken.setCustomClaim(ns, event.authorization?.roles || []);
    //      api.accessToken.setCustomClaim(ns, event.authorization?.roles || []);
    //    };
    //
    //    → User Management → Roles → Create "admin" role → assign to your account.
    const roles   = user[ROLES_CLAIM] || [];
    const isAdmin = roles.includes('admin');

    // 4. Detect new signup vs returning login
    let isNewUser = false;
    try {
      const existing = await supabase.get(
        '/rest/v1/users',
        `auth0_sub=eq.${encodeURIComponent(sub)}&select=id`
      );
      isNewUser = existing.length === 0;
    } catch { /* safe default: assume returning */ }

    // 5. Fire notifications (non-blocking)
    if (isNewUser) {
      notify.newSignup({ name, email, sub, ip, userAgent })
        .catch(err => console.error('notify.newSignup error:', err));
    } else {
      notify.loginDetected({ name, email, ip, userAgent })
        .catch(err => console.error('notify.loginDetected error:', err));
    }

    // 6. Build signed session — isAdmin baked in server-side
    const payload = {
      sub,
      email,
      name,
      picture: user.picture || null,
      isAdmin,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
    };

    const sessionValue = signPayload(payload, AUTH0_COOKIE_SECRET);

    // 7. Admins → /admin.html, users → /dashboard.html
    const destination = isAdmin ? '/admin.html' : '/dashboard.html';

    return {
      statusCode: 302,
      headers: {
        Location: destination,
        'Set-Cookie': [
          `${COOKIE_NAME}=${sessionValue}`,
          `Max-Age=${MAX_AGE_SECONDS}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Lax',
          'Secure',
        ].join('; '),
      },
      body: '',
    };
  } catch (err) {
    console.error('auth-callback error:', err);
    return redirect('/?auth_error=server_error');
  }
};

function redirect(location) {
  return { statusCode: 302, headers: { Location: location }, body: '' };
}

function signPayload(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
