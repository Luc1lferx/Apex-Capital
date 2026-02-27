// netlify/functions/auth-user.js
// Called by the frontend to verify the session cookie and get user info.
// Returns { ok: true, user: { email, name, picture, sub } }
// or      { ok: false } with a 401 if the session is missing/invalid/expired.

const crypto = require('crypto');

const { AUTH0_COOKIE_SECRET } = process.env;
const COOKIE_NAME = 'apex_session';

exports.handler = async (event) => {
  const cookieHeader = event.headers['cookie'] || '';
  const raw = parseCookie(cookieHeader, COOKIE_NAME);

  if (!raw) return unauth();

  const payload = verifyPayload(raw, AUTH0_COOKIE_SECRET);
  if (!payload) return unauth();

  // Check expiry
  if (payload.exp && Date.now() / 1000 > payload.exp) return unauth();

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({
      ok: true,
      user: {
        sub:     payload.sub,
        email:   payload.email,
        name:    payload.name,
        picture: payload.picture,
      },
    }),
  };
};

// ── helpers ───────────────────────────────────────────────────────────────────

function unauth() {
  return {
    statusCode: 401,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: false }),
  };
}

function parseCookie(header, name) {
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

function verifyPayload(token, secret) {
  try {
    const [data, sig] = token.split('.');
    if (!data || !sig) return null;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
