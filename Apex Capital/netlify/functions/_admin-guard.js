// netlify/functions/_admin-guard.js
// Shared middleware for all admin functions.
// Verifies the session cookie AND the isAdmin flag baked in at login.
// Prefixed _ so Netlify does not expose it as a public endpoint.

const { getSession, unauth, forbidden, json } = require('./_db');

/**
 * Wraps an admin handler. Usage:
 *   exports.handler = requireAdmin(async (event, session) => { ... });
 */
function requireAdmin(handler) {
  return async (event) => {
    // Only allow expected HTTP methods — caller can override by checking in handler
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, body: '' };
    }

    const session = getSession(event);
    if (!session) return unauth();
    if (!session.isAdmin) return forbidden();

    try {
      return await handler(event, session);
    } catch (err) {
      console.error('Admin handler error:', err);
      return json(502, { ok: false, error: err.message });
    }
  };
}

module.exports = { requireAdmin };
