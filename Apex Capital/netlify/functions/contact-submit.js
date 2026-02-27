// netlify/functions/contact-submit.js
// Handles the contact / investor inquiry form submission.
// Stores the submission in Supabase and fires email notifications.
//
// POST /.netlify/functions/contact-submit
// Body (JSON):
// {
//   firstName:   string,
//   lastName:    string,
//   institution: string,
//   email:       string,
//   interest:    string,
//   message:     string,
// }

const { supabase, ok, badReq, serverErr } = require('./_db');
const notify = require('./_notify');

// Simple honeypot + rate limiting via a timestamp field
const REQUIRED_FIELDS = ['firstName', 'lastName', 'email', 'message'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return badReq('Invalid JSON'); }

  // Honeypot — bots fill hidden fields
  if (body._hp) return ok({ received: true }); // silently discard

  // Validate required fields
  for (const f of REQUIRED_FIELDS) {
    if (!body[f]?.trim()) return badReq(`Missing required field: ${f}`);
  }

  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return badReq('Invalid email address');

  // Length guards
  if (body.message.length > 4000) return badReq('Message too long (max 4000 characters)');

  const name        = `${body.firstName.trim()} ${body.lastName.trim()}`;
  const email       = body.email.trim().toLowerCase();
  const institution = body.institution?.trim() || null;
  const interest    = body.interest?.trim()    || null;
  const message     = body.message.trim();

  const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim()
          || event.headers['client-ip']
          || 'unknown';
  const userAgent = event.headers['user-agent'] || 'unknown';

  try {
    // ── 1. Store in Supabase ───────────────────────────────────────────────
    // Requires a `contact_submissions` table — add this to your schema:
    // CREATE TABLE IF NOT EXISTS contact_submissions (
    //   id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    //   name        TEXT NOT NULL,
    //   email       TEXT NOT NULL,
    //   institution TEXT,
    //   interest    TEXT,
    //   message     TEXT NOT NULL,
    //   ip_address  TEXT,
    //   user_agent  TEXT,
    //   status      TEXT NOT NULL DEFAULT 'new',  -- new | reviewed | replied
    //   created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    // );
    const [submission] = await supabase.post('/rest/v1/contact_submissions', {
      name,
      email,
      institution,
      interest,
      message,
      ip_address: ip,
      user_agent: userAgent,
      status:     'new',
      created_at: new Date().toISOString(),
    });

    // ── 2. Fire emails ─────────────────────────────────────────────────────
    // Fire-and-forget — don't block the response on email delivery
    notify.contactReceived({ name, email, institution, interest, message, ip })
      .catch(err => console.error('notify.contactReceived error:', err));

    return ok({ received: true, id: submission?.id || null });

  } catch (err) {
    console.error('contact-submit error:', err);

    // Still try to send the email even if DB write failed
    notify.contactReceived({ name, email, institution, interest, message, ip })
      .catch(() => {});

    return serverErr('Submission could not be saved. Please try again.');
  }
};
