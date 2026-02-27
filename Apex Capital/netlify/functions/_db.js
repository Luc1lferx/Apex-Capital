// netlify/functions/_db.js
// Shared Supabase client + auth session verifier.
// Prefixed with _ so Netlify does NOT deploy it as a function endpoint.
//
// Required env vars:
//   SUPABASE_URL          e.g. https://xyzxyz.supabase.co
//   SUPABASE_SERVICE_KEY  service_role secret key (never expose to frontend)
//   AUTH0_COOKIE_SECRET   same secret used in auth-callback.js

const crypto = require('crypto');

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const AUTH0_COOKIE_SECRET  = process.env.AUTH0_COOKIE_SECRET;
const COOKIE_NAME          = 'apex_session';

// ── Supabase REST helper ──────────────────────────────────────────────────────

/**
 * Generic Supabase REST call.
 * @param {string} path   e.g. '/rest/v1/users'
 * @param {object} opts   fetch options (method, body, headers merged)
 */
async function supabase(path, opts = {}) {
  const url = `${SUPABASE_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer':        'return=representation',
      ...(opts.headers || {}),
    },
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    throw new Error(`Supabase ${opts.method || 'GET'} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Convenience wrappers
supabase.get    = (path, qs = '')  => supabase(`${path}?${qs}`, { method: 'GET' });
supabase.post   = (path, body)     => supabase(path, { method: 'POST',  body: JSON.stringify(body) });
supabase.patch  = (path, qs, body) => supabase(`${path}?${qs}`, { method: 'PATCH', body: JSON.stringify(body) });
supabase.delete = (path, qs)       => supabase(`${path}?${qs}`, { method: 'DELETE' });
supabase.rpc    = (fn, body)       => supabase(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) });

// ── Session verification ──────────────────────────────────────────────────────

/**
 * Parse and verify the apex_session cookie from an event.
 * Returns the decoded payload { sub, email, name, ... } or null.
 */
function getSession(event) {
  const cookieHeader = event.headers['cookie'] || '';
  const raw = cookieHeader
    .split(';')
    .map(s => s.trim())
    .find(s => s.startsWith(COOKIE_NAME + '='));

  if (!raw) return null;
  const token = raw.slice(COOKIE_NAME.length + 1);

  try {
    const [data, sig] = token.split('.');
    if (!data || !sig) return null;
    const expected = crypto
      .createHmac('sha256', AUTH0_COOKIE_SECRET)
      .update(data)
      .digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Audit logger ─────────────────────────────────────────────────────────────

/**
 * Write a row to audit_log. Fire-and-forget — never throws.
 */
async function auditLog({ userId, action, meta = {}, event }) {
  try {
    const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || event.headers['client-ip']
      || 'unknown';
    const userAgent = event.headers['user-agent'] || 'unknown';

    await supabase.post('/rest/v1/audit_log', {
      user_id:    userId,
      action,
      ip_address: ip,
      user_agent: userAgent,
      meta:       JSON.stringify(meta),
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    // Never let audit failure break the main request
    console.error('auditLog error:', err.message);
  }
}

// ── Standard HTTP responses ───────────────────────────────────────────────────

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const ok      = data  => json(200, { ok: true,  ...data });
const created = data  => json(201, { ok: true,  ...data });
const badReq  = msg   => json(400, { ok: false, error: msg });
const unauth  = ()    => json(401, { ok: false, error: 'Unauthorised' });
const forbidden = ()  => json(403, { ok: false, error: 'Forbidden' });
const serverErr = msg => json(502, { ok: false, error: msg });

module.exports = { supabase, getSession, auditLog, ok, created, badReq, unauth, forbidden, serverErr };
