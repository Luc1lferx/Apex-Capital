// netlify/functions/deposit-webhook.js
// Receives and processes Coinbase Commerce webhook events.
// Verifies the HMAC-SHA256 signature, then handles:
//   charge:created    → update status to pending (usually already set)
//   charge:pending    → payment detected on-chain, not confirmed yet
//   charge:confirmed  → N confirmations reached → credit balance
//   charge:failed     → payment failed / expired → mark failed
//   charge:delayed    → under-payment detected
//   charge:resolved   → manually resolved by Coinbase
//
// POST /.netlify/functions/deposit-webhook
// Public endpoint — no session cookie. Security via HMAC signature only.
//
// Required env vars:
//   COINBASE_COMMERCE_WEBHOOK_SECRET   from Commerce dashboard → Settings → Webhook subscriptions

const crypto = require('crypto');
const { supabase, auditLog, serverErr } = require('./_db');
const notify = require('./_notify');

const WEBHOOK_SECRET = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  // ── 1. Verify Coinbase HMAC signature ─────────────────────────────────────
  const signature = event.headers['x-cc-webhook-signature'] || '';
  const rawBody   = event.body || '';

  if (!WEBHOOK_SECRET) {
    console.error('COINBASE_COMMERCE_WEBHOOK_SECRET not configured');
    return { statusCode: 500, body: 'Webhook secret not configured' };
  }

  const expectedSig = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
    console.warn('Webhook signature mismatch — possible spoofed request');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  // ── 2. Parse event ────────────────────────────────────────────────────────
  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { type, data } = payload.event || {};
  if (!type || !data) return { statusCode: 400, body: 'Missing event type or data' };

  const coinbaseChargeId = data.id;
  const chargeCode       = data.code;
  const metadata         = data.metadata || {};

  console.log(`[webhook] ${type} — charge: ${coinbaseChargeId}`);

  try {
    // ── 3. Look up our deposit charge record ──────────────────────────────
    const charges = await supabase.get(
      '/rest/v1/deposit_charges',
      `coinbase_charge_id=eq.${encodeURIComponent(coinbaseChargeId)}&select=*`
    );

    if (!charges.length) {
      // Could be a test webhook or a charge we don't track
      console.warn(`No charge found for coinbase_id: ${coinbaseChargeId}`);
      return { statusCode: 200, body: 'OK' }; // Always return 200 to Coinbase
    }

    const charge = charges[0];

    // ── 4. Handle each event type ─────────────────────────────────────────

    switch (type) {

      case 'charge:created':
        // Usually already handled at create time — just ensure status is pending
        await updateChargeStatus(charge.id, 'pending', {});
        break;

      case 'charge:pending': {
        // Payment detected on-chain but not confirmed yet
        // Extract confirmation count from payments array if available
        const payments      = data.payments || [];
        const latestPayment = payments[payments.length - 1] || {};
        const confirmations = parseInt(latestPayment.transaction_id ? 0 : 0); // not confirmed yet

        await updateChargeStatus(charge.id, 'detected', {
          confirmations: 0,
          network_tx:    latestPayment.transaction_id || null,
        });

        // Notify user their payment was detected
        const userRows = await supabase.get('/rest/v1/users', `id=eq.${charge.user_id}&select=email,name`);
        if (userRows.length) {
          notify.transactionInitiated({
            userName:  userRows[0].name || userRows[0].email,
            userEmail: userRows[0].email,
            type:      'deposit',
            asset:     charge.asset,
            amount:    charge.crypto_amount || 0,
            usdValue:  charge.amount_usd,
            status:    'processing',
            txId:      charge.id,
            ip:        'coinbase-webhook',
          }).catch(() => {});
        }
        break;
      }

      case 'charge:confirmed': {
        // ── CONFIRMED: credit the balance ─────────────────────────────────
        if (charge.credited) {
          // Idempotency guard — never double-credit
          console.log(`Charge ${charge.id} already credited — skipping`);
          break;
        }

        // Extract crypto amount from confirmed payment
        const payments      = data.payments || [];
        const confirmedPmt  = payments.find(p => p.status === 'CONFIRMED') || payments[payments.length - 1] || {};
        const cryptoAmount  = parseFloat(confirmedPmt.value?.crypto?.amount || charge.crypto_amount || 0);
        const networkTx     = confirmedPmt.transaction_id || null;
        const confirmations = parseInt(confirmedPmt.block?.confirmations || charge.confirm_threshold);

        // Check we've hit the threshold
        if (confirmations < charge.confirm_threshold) {
          console.log(`Charge ${charge.id}: ${confirmations}/${charge.confirm_threshold} confirmations — not crediting yet`);
          await updateChargeStatus(charge.id, 'confirming', { confirmations, network_tx: networkTx });
          break;
        }

        // Atomic balance credit
        await supabase.rpc('upsert_balance', {
          p_user_id: charge.user_id,
          p_asset:   charge.asset,
          p_delta:   cryptoAmount || charge.crypto_amount,
        });

        // Create transaction record
        const [tx] = await supabase.post('/rest/v1/transactions', {
          user_id:    charge.user_id,
          type:       'deposit',
          asset:      charge.asset,
          amount:     cryptoAmount || charge.crypto_amount,
          usd_value:  charge.amount_usd,
          status:     'completed',
          tx_hash:    networkTx,
          notes:      `Coinbase Commerce — charge ${charge.coinbase_charge_code}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        // Mark charge as credited (idempotency)
        await supabase.patch(
          '/rest/v1/deposit_charges',
          `id=eq.${charge.id}`,
          {
            status:        'completed',
            credited:      true,
            confirmations,
            network_tx:    networkTx,
            transaction_id: tx?.id || null,
            updated_at:    new Date().toISOString(),
          }
        );

        // Audit log
        await auditLog({
          userId: charge.user_id,
          action: 'deposit_credited',
          meta: {
            charge_id:      charge.id,
            coinbase_id:    coinbaseChargeId,
            asset:          charge.asset,
            crypto_amount:  cryptoAmount,
            usd_value:      charge.amount_usd,
            confirmations,
            network_tx:     networkTx,
            transaction_id: tx?.id,
          },
          event: { headers: {} }, // webhook — no real client IP
        });

        // Notify user of successful credit
        const userRows = await supabase.get('/rest/v1/users', `id=eq.${charge.user_id}&select=email,name`);
        if (userRows.length) {
          notify.transactionInitiated({
            userName:  userRows[0].name || userRows[0].email,
            userEmail: userRows[0].email,
            type:      'deposit',
            asset:     charge.asset,
            amount:    cryptoAmount || charge.crypto_amount,
            usdValue:  charge.amount_usd,
            status:    'completed',
            txId:      tx?.id || charge.id,
            ip:        'coinbase-webhook',
          }).catch(() => {});
        }

        console.log(`✓ Credited ${cryptoAmount} ${charge.asset} to user ${charge.user_id}`);
        break;
      }

      case 'charge:failed':
      case 'charge:expired': {
        await updateChargeStatus(charge.id, 'failed', {});

        await auditLog({
          userId: charge.user_id,
          action: 'deposit_failed',
          meta:   { charge_id: charge.id, coinbase_id: coinbaseChargeId, event_type: type },
          event:  { headers: {} },
        });
        break;
      }

      case 'charge:delayed': {
        // Under-payment — mark for review
        await updateChargeStatus(charge.id, 'underpaid', {});
        break;
      }

      case 'charge:resolved': {
        // Manually resolved by Coinbase support
        await updateChargeStatus(charge.id, 'resolved', {});
        break;
      }

      default:
        console.log(`[webhook] Unhandled event type: ${type}`);
    }

    // Always return 200 to Coinbase — failure causes retries
    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error('[webhook] Processing error:', err);
    // Still return 200 to prevent Coinbase retrying a broken charge
    return { statusCode: 200, body: JSON.stringify({ received: true, error: err.message }) };
  }
};

// ── helpers ───────────────────────────────────────────────────────────────────

async function updateChargeStatus(chargeId, status, extra = {}) {
  return supabase.patch(
    '/rest/v1/deposit_charges',
    `id=eq.${chargeId}`,
    { status, ...extra, updated_at: new Date().toISOString() }
  );
}
