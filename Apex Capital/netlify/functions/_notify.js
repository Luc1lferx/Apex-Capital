// netlify/functions/_notify.js
// Shared email notification helper — powered by Resend.
// Prefixed with _ so Netlify does NOT expose it as a public endpoint.
//
// Required env vars:
//   RESEND_API_KEY      from resend.com → API Keys
//   NOTIFY_FROM         verified sender e.g. "Apex Capital <noreply@yourdomain.com>"
//   NOTIFY_ADMIN_EMAIL  your email address for admin alerts
//   SITE_NAME           e.g. "Apex Capital" (optional, defaults to that)

const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const FROM              = process.env.NOTIFY_FROM          || 'Apex Capital <noreply@apexcapital.com>';
const ADMIN_EMAIL       = process.env.NOTIFY_ADMIN_EMAIL   || 'admin@apexcapital.com';
const SITE_NAME         = process.env.SITE_NAME            || 'Apex Capital';
const SITE_URL          = process.env.URL                  || 'https://apexcapital.com';

// ── Core send function ────────────────────────────────────────────────────────

async function sendEmail({ to, subject, html, replyTo }) {
  if (!RESEND_API_KEY) {
    console.warn('[notify] RESEND_API_KEY not set — skipping email send');
    return { skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from:     FROM,
      to:       Array.isArray(to) ? to : [to],
      subject,
      html,
      reply_to: replyTo || ADMIN_EMAIL,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ── Shared HTML wrapper ───────────────────────────────────────────────────────

function emailShell({ title, preheader, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;color:#0d1117">${preheader}</div>

<!-- Wrapper -->
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:40px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <!-- Header -->
  <tr><td style="background:#0a0f1e;border:1px solid rgba(201,168,76,0.25);border-bottom:none;padding:32px 40px;text-align:center">
    <div style="font-size:22px;font-weight:400;letter-spacing:4px;text-transform:uppercase;color:#c9a84c">
      ${SITE_NAME.toUpperCase().replace(' ', '<span style="color:#f7f3ea"> </span>')}
    </div>
    <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#4a5a72;margin-top:6px">Digital Asset Management</div>
  </td></tr>

  <!-- Gold bar -->
  <tr><td style="height:2px;background:linear-gradient(90deg,transparent,#c9a84c,transparent)"></td></tr>

  <!-- Body -->
  <tr><td style="background:#111827;border:1px solid rgba(201,168,76,0.15);border-top:none;border-bottom:none;padding:40px">
    ${bodyHtml}
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#0a0f1e;border:1px solid rgba(201,168,76,0.25);border-top:1px solid rgba(201,168,76,0.1);padding:24px 40px;text-align:center">
    <p style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#4a5a72;margin:0 0 8px">
      ${SITE_NAME} · Authorised & Regulated by the FCA
    </p>
    <p style="font-size:11px;color:#3a4a5a;margin:0">
      One Canada Square, Canary Wharf, London E14 5AB<br>
      <a href="${SITE_URL}" style="color:#c9a84c;text-decoration:none">${SITE_URL}</a>
    </p>
    <p style="font-size:10px;color:#2a3a4a;margin:14px 0 0">
      This email was sent because you have an account with ${SITE_NAME}.<br>
      If you did not expect this email, please contact us immediately.
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// Reusable UI chunks
const heading = (text) =>
  `<h1 style="font-family:Georgia,serif;font-size:26px;font-weight:300;color:#f7f3ea;margin:0 0 8px">${text}</h1>`;

const subheading = (text) =>
  `<p style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#c9a84c;margin:0 0 28px">${text}</p>`;

const divider = () =>
  `<div style="height:1px;background:rgba(201,168,76,0.2);margin:28px 0"></div>`;

const bodyText = (text) =>
  `<p style="font-size:15px;line-height:1.7;color:#8a9ab5;margin:0 0 16px">${text}</p>`;

const dataRow = (label, value, highlight = false) =>
  `<tr>
    <td style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#4a5a72;padding:10px 0;border-bottom:1px solid rgba(201,168,76,0.07);width:40%">${label}</td>
    <td style="font-family:'Courier New',monospace;font-size:13px;color:${highlight ? '#c9a84c' : '#f7f3ea'};padding:10px 0 10px 16px;border-bottom:1px solid rgba(201,168,76,0.07)">${value}</td>
  </tr>`;

const ctaButton = (text, url) =>
  `<div style="text-align:center;margin:32px 0">
    <a href="${url}" style="display:inline-block;background:#c9a84c;color:#0a0f1e;padding:14px 36px;font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;text-decoration:none">${text}</a>
  </div>`;

const alertBox = (text, type = 'info') => {
  const colors = {
    info:    { bg: 'rgba(201,168,76,0.06)',  border: 'rgba(201,168,76,0.25)',  text: '#c9a84c' },
    success: { bg: 'rgba(76,175,130,0.06)',  border: 'rgba(76,175,130,0.25)', text: '#4caf82' },
    warning: { bg: 'rgba(224,92,92,0.06)',   border: 'rgba(224,92,92,0.25)',  text: '#e05c5c' },
  };
  const c = colors[type] || colors.info;
  return `<div style="background:${c.bg};border:1px solid ${c.border};padding:14px 18px;margin:20px 0;font-size:13px;color:${c.text};line-height:1.6">${text}</div>`;
};

// ── Template builders ─────────────────────────────────────────────────────────

function tplContactAdmin({ name, email, institution, interest, message, ip }) {
  return emailShell({
    title:     `New Investor Inquiry — ${name}`,
    preheader: `${name} from ${institution || 'unknown'} submitted an inquiry`,
    bodyHtml: `
      ${subheading('New Investor Inquiry')}
      ${heading('Contact Form Submission')}
      ${divider()}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px">
        ${dataRow('Name',        name,                    true)}
        ${dataRow('Email',       `<a href="mailto:${email}" style="color:#c9a84c">${email}</a>`)}
        ${dataRow('Institution', institution || '—')}
        ${dataRow('Interest',    interest    || '—')}
        ${dataRow('Submitted',   new Date().toUTCString())}
        ${dataRow('IP Address',  ip          || 'unknown')}
      </table>
      ${divider()}
      <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#4a5a72;margin-bottom:12px">Message</div>
      <div style="background:#0a0f1e;border:1px solid rgba(201,168,76,0.15);padding:20px;font-size:14px;color:#f7f3ea;line-height:1.7">${message || '(no message)'}</div>
      ${ctaButton('Reply to Inquiry', `mailto:${email}?subject=Re: Your Apex Capital Inquiry`)}
    `,
  });
}

function tplContactUser({ name }) {
  return emailShell({
    title:     'We received your inquiry — Apex Capital',
    preheader: 'Thank you for reaching out. Our investor relations team will be in touch shortly.',
    bodyHtml: `
      ${subheading('Inquiry Received')}
      ${heading(`Thank you, ${name.split(' ')[0]}.`)}
      ${divider()}
      ${bodyText('We\'ve received your inquiry and a member of our Investor Relations team will review it and be in touch within <strong style="color:#f7f3ea">1–2 business days</strong>.')}
      ${bodyText('In the meantime, you may wish to explore our strategies and research on our website.')}
      ${alertBox('We work exclusively with qualified institutional investors, family offices, and high-net-worth individuals. Minimum commitment from $500,000 USD equivalent.', 'info')}
      ${ctaButton('Visit Our Website', SITE_URL)}
      ${divider()}
      ${bodyText('<span style="font-size:13px">If you have an urgent matter, please contact us directly at <a href="mailto:ir@apexcapital.com" style="color:#c9a84c">ir@apexcapital.com</a> or call +44 20 7123 4567.</span>')}
    `,
  });
}

function tplTransactionUser({ name, type, asset, amount, usdValue, feeUsd, status, txId, date }) {
  const isDeposit  = type === 'deposit';
  const typeLabel  = isDeposit ? 'Deposit' : 'Withdrawal';
  const statusColor = { pending:'#c9a84c', processing:'#6495ed', completed:'#4caf82', failed:'#e05c5c' }[status] || '#8a9ab5';
  return emailShell({
    title:     `${typeLabel} ${isDeposit ? 'Received' : 'Requested'} — ${SITE_NAME}`,
    preheader: `Your ${typeLabel.toLowerCase()} of ${amount} ${asset} (${usdValue}) has been ${isDeposit ? 'received and is processing' : 'submitted for review'}.`,
    bodyHtml: `
      ${subheading(typeLabel + ' ' + (isDeposit ? 'Confirmation' : 'Request'))}
      ${heading(isDeposit ? 'Deposit Received' : 'Withdrawal Submitted')}
      ${divider()}
      ${bodyText(isDeposit
        ? `Your deposit has been received and is currently being processed. You will receive another notification once it has been confirmed on-chain.`
        : `Your withdrawal request has been submitted and is pending compliance review. Processing typically takes <strong style="color:#f7f3ea">1–3 business days</strong>.`
      )}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
        ${dataRow('Transaction ID', `<span style="font-size:11px">${txId}</span>`)}
        ${dataRow('Type',           typeLabel,      true)}
        ${dataRow('Asset',          asset,          true)}
        ${dataRow('Amount',         amount)}
        ${dataRow('USD Value',      usdValue)}
        ${feeUsd ? dataRow('Platform Fee', feeUsd) : ''}
        ${dataRow('Status',         `<span style="color:${statusColor};text-transform:uppercase">${status}</span>`)}
        ${dataRow('Date',           date)}
      </table>
      ${isDeposit
        ? alertBox('Funds will be credited to your account after the required network confirmations. This typically takes 10–60 minutes depending on network congestion.', 'info')
        : alertBox('⚠ Withdrawals cannot be reversed once processed. If you did not initiate this request, contact us immediately.', 'warning')
      }
      ${ctaButton('View in Dashboard', `${SITE_URL}/dashboard.html`)}
    `,
  });
}

function tplTransactionAdmin({ userName, userEmail, type, asset, amount, usdValue, feeUsd, status, txId, ip }) {
  const isDeposit = type === 'deposit';
  return emailShell({
    title:     `[${type.toUpperCase()}] ${amount} ${asset} — ${userName}`,
    preheader: `${userName} initiated a ${type} of ${amount} ${asset} (${usdValue})`,
    bodyHtml: `
      ${subheading('Transaction Alert')}
      ${heading(`New ${isDeposit ? 'Deposit' : 'Withdrawal'}`)}
      ${divider()}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px">
        ${dataRow('User',           `${userName} &lt;${userEmail}&gt;`)}
        ${dataRow('Transaction ID', `<span style="font-size:11px">${txId}</span>`)}
        ${dataRow('Type',           type,      true)}
        ${dataRow('Asset',          asset,     true)}
        ${dataRow('Amount',         amount)}
        ${dataRow('USD Value',      usdValue,  true)}
        ${feeUsd ? dataRow('Fee Collected', feeUsd) : ''}
        ${dataRow('Status',         status)}
        ${dataRow('IP Address',     ip || 'unknown')}
        ${dataRow('Timestamp',      new Date().toUTCString())}
      </table>
      ${!isDeposit ? alertBox('⚠ This withdrawal requires compliance review before processing.', 'warning') : ''}
      ${ctaButton('View in Supabase', `https://supabase.com/dashboard`)}
    `,
  });
}

function tplWelcomeUser({ name, email }) {
  return emailShell({
    title:     `Welcome to ${SITE_NAME}`,
    preheader: `Your account has been created. Welcome to institutional-grade digital asset management.`,
    bodyHtml: `
      ${subheading('Account Created')}
      ${heading(`Welcome, ${name.split(' ')[0]}.`)}
      ${divider()}
      ${bodyText(`Your ${SITE_NAME} account has been successfully created and is ready to use.`)}
      ${bodyText('You now have access to the Client Portal where you can manage deposits, withdrawals, and monitor your portfolio performance.')}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
        ${dataRow('Account Email', email)}
        ${dataRow('Account Type',  'Client Portal')}
        ${dataRow('KYC Status',    '<span style="color:#c9a84c">Pending Verification</span>')}
        ${dataRow('Created',       new Date().toUTCString())}
      </table>
      ${alertBox('To unlock full withdrawal capabilities, our compliance team will reach out to complete KYC verification within 1–2 business days.', 'info')}
      ${ctaButton('Go to Your Dashboard', `${SITE_URL}/dashboard.html`)}
      ${divider()}
      ${bodyText('<span style="font-size:13px">Questions? Reach our Investor Relations team at <a href="mailto:ir@apexcapital.com" style="color:#c9a84c">ir@apexcapital.com</a></span>')}
    `,
  });
}

function tplNewSignupAdmin({ name, email, sub, ip, userAgent }) {
  return emailShell({
    title:     `New Signup — ${name}`,
    preheader: `${name} (${email}) just created an account`,
    bodyHtml: `
      ${subheading('New User Registration')}
      ${heading('New Account Created')}
      ${divider()}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px">
        ${dataRow('Name',       name,  true)}
        ${dataRow('Email',      `<a href="mailto:${email}" style="color:#c9a84c">${email}</a>`)}
        ${dataRow('Auth0 Sub',  `<span style="font-size:11px">${sub}</span>`)}
        ${dataRow('IP Address', ip          || 'unknown')}
        ${dataRow('Device',     userAgent ? userAgent.substring(0, 80) + '…' : 'unknown')}
        ${dataRow('Timestamp',  new Date().toUTCString())}
      </table>
      ${alertBox('KYC verification required before this user can make withdrawals. Schedule onboarding call.', 'info')}
      ${ctaButton('View in Supabase', `https://supabase.com/dashboard`)}
    `,
  });
}

function tplLoginUser({ name, ip, userAgent, date }) {
  // Only send login notifications — don't send on every login to avoid fatigue.
  // Caller should decide when to trigger (e.g. new IP, or always).
  return emailShell({
    title:     `New login to your ${SITE_NAME} account`,
    preheader: `A new login was detected on your account from ${ip || 'an unknown location'}.`,
    bodyHtml: `
      ${subheading('Security Alert')}
      ${heading('New Login Detected')}
      ${divider()}
      ${bodyText(`A new sign-in to your ${SITE_NAME} account was detected.`)}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
        ${dataRow('Account',    name)}
        ${dataRow('Date & Time', date || new Date().toUTCString())}
        ${dataRow('IP Address',  ip          || 'unknown')}
        ${dataRow('Device',      userAgent ? userAgent.substring(0, 70) + '…' : 'unknown')}
      </table>
      ${alertBox('⚠ If this was not you, please <a href="' + SITE_URL + '/.netlify/functions/auth-logout" style="color:#e05c5c">sign out immediately</a> and contact our support team.', 'warning')}
      ${ctaButton('Review Account Security', `${SITE_URL}/dashboard.html`)}
    `,
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

const notify = {

  async contactReceived({ name, email, institution, interest, message, ip }) {
    await Promise.allSettled([
      sendEmail({ to: ADMIN_EMAIL, subject: `📩 New Inquiry: ${name} — ${institution || email}`,   html: tplContactAdmin({ name, email, institution, interest, message, ip }) }),
      sendEmail({ to: email,       subject: `We received your inquiry — ${SITE_NAME}`,              html: tplContactUser({ name }) }),
    ]);
  },

  async transactionInitiated({ userName, userEmail, type, asset, amount, usdValue, feeUsd, status, txId, ip }) {
    const fmtAmount = `${amount} ${asset}`;
    const fmtUsd    = `$${Number(usdValue).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`;
    const fmtFee    = feeUsd ? `$${Number(feeUsd).toFixed(2)}` : null;
    const date      = new Date().toUTCString();
    await Promise.allSettled([
      sendEmail({ to: userEmail,   subject: `${type === 'deposit' ? 'Deposit received' : 'Withdrawal submitted'} — ${fmtAmount}`, html: tplTransactionUser({ name: userName, type, asset, amount: fmtAmount, usdValue: fmtUsd, feeUsd: fmtFee, status, txId, date }) }),
      sendEmail({ to: ADMIN_EMAIL, subject: `[${type.toUpperCase()}] ${fmtAmount} (${fmtUsd}) — ${userName}`,                     html: tplTransactionAdmin({ userName, userEmail, type, asset, amount: fmtAmount, usdValue: fmtUsd, feeUsd: fmtFee, status, txId, ip }) }),
    ]);
  },

  async newSignup({ name, email, sub, ip, userAgent }) {
    await Promise.allSettled([
      sendEmail({ to: email,       subject: `Welcome to ${SITE_NAME}`,    html: tplWelcomeUser({ name, email }) }),
      sendEmail({ to: ADMIN_EMAIL, subject: `🆕 New signup: ${name}`,     html: tplNewSignupAdmin({ name, email, sub, ip, userAgent }) }),
    ]);
  },

  async loginDetected({ name, email, ip, userAgent }) {
    const date = new Date().toUTCString();
    // Send to user only — admin doesn't need a ping on every login
    await Promise.allSettled([
      sendEmail({ to: email, subject: `New login to your ${SITE_NAME} account`, html: tplLoginUser({ name, ip, userAgent, date }) }),
    ]);
  },
};

module.exports = notify;
