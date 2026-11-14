const crypto = require('node:crypto');
const express = require('express');
const { normalizeKenyanPhone, sendTextSms } = require('./textsms');
const { deriveStatus } = require('./outdoor-wifi');
const { createCourtneyTechClient } = require('./courtneytech');

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const OTP_MAX_REQUESTS_PER_HOUR = 4;
const OTP_MAX_ATTEMPTS = 5;
const PORTAL_SESSION_TTL_MS = 20 * 60 * 1000;
const MAX_PAYMENT_AMOUNT_KES = 70000;
const SUPPORT_PHONE = '0113313240';
const COURTNEY_CALLBACK_URL = 'https://anonymikeconnect-mpw.onrender.com/api/webhooks/courtneytech';
const challengeSecret = crypto.randomBytes(32);
const sessionSigningSecret = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || challengeSecret;

function hashCode(phone, code) {
  return crypto.createHmac('sha256', challengeSecret).update(`${phone}:${code}`).digest();
}

function constantTimeEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function phoneVariants(phone) {
  return [phone, `0${phone.slice(3)}`];
}

function createPortalSessionToken(clientId, timestamp, secret = sessionSigningSecret) {
  const payload = Buffer.from(JSON.stringify({ clientId, expiresAt: timestamp + PORTAL_SESSION_TTL_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readPortalSessionToken(token, timestamp, secret = sessionSigningSecret) {
  const [payload, signature, ...extra] = String(token || '').split('.');
  if (!payload || !signature || extra.length) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  const provided = Buffer.from(signature, 'base64url');
  if (!constantTimeEqual(expected, provided)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!/^[0-9a-f-]{36}$/i.test(session.clientId) || !Number.isFinite(session.expiresAt) || session.expiresAt <= timestamp) return null;
    return session;
  } catch {
    return null;
  }
}

function packageDurationMs(duration) {
  const match = /^(\d{1,5})\s*(minutes?|hours?|days?)$/i.exec(String(duration || '').trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith('minute') ? 60_000 : unit.startsWith('hour') ? 3_600_000 : 86_400_000;
  const milliseconds = amount * multiplier;
  return amount > 0 && milliseconds <= 366 * 86_400_000 ? milliseconds : null;
}

function findSubscriber(db, phone) {
  return db.query(
    `select 1
     from outdoor_wifi_clients c
     where regexp_replace(c.phone, '[^0-9]', '', 'g') = any($1::text[])
       and c.status <> 'CANCELLED'
     limit 1`,
    [phoneVariants(phone)]
  );
}

async function loadPortalData({ db, clientId, normalizePhone = normalizeKenyanPhone, getStatus = deriveStatus, timestamp = Date.now() }) {
  const result = await db.query(
    `select c.id, c.customer_name, c.phone, c.package_name, c.package_price,
            c.package_id, c.activation_at, c.expected_expiry_at, c.status,
            c.blacklist_enabled, c.created_at, c.order_id,
            linked_order.paid_at as linked_paid_at,
            previous_payment.paid_at as previous_paid_at,
            linked_order.status as linked_order_status,
            linked_order.payment_provider as linked_payment_provider,
            linked_order.provider_checkout_id as linked_checkout_id,
            linked_order.amount as linked_amount,
            linked_package.name as linked_package_name
     from outdoor_wifi_clients c
     left join orders linked_order on linked_order.id = c.order_id
     left join packages linked_package on linked_package.id = linked_order.package_id
     left join lateral (
       select o.paid_at
       from orders o
       where regexp_replace(o.phone, '[^0-9]', '', 'g') = regexp_replace(c.phone, '[^0-9]', '', 'g')
         and o.package_id = c.package_id
         and o.paid_at is not null
       order by o.paid_at desc
       limit 1
     ) previous_payment on true
     where c.id = $1 and c.status <> 'CANCELLED'
     limit 1`,
    [clientId]
  );
  if (!result.rowCount) return null;

  const client = result.rows[0];
  let maskedPhone = '••••';
  try {
    const normalized = normalizePhone(client.phone);
    maskedPhone = `+254${normalized.slice(3, 6)}••••${normalized.slice(-2)}`;
  } catch {}

  const paidAt = client.linked_paid_at || client.previous_paid_at || null;
  const expiresAt = new Date(client.expected_expiry_at).getTime();
  const subscriberStatus = getStatus(client, new Date(timestamp));
  const wifiSsid = String(process.env.OUTDOOR_WIFI_SSID || '').trim();
  const wifiPassword = String(process.env.OUTDOOR_WIFI_PASSWORD || '');
  const wifiEligible = ['ACTIVE', 'EXPIRING_SOON'].includes(subscriberStatus);
  const wifiAvailable = wifiEligible && Boolean(wifiSsid && wifiPassword);
  const wifiMessage = !wifiEligible
    ? 'Wi-Fi credentials are shown while your subscription is active. Renew your package or contact support.'
    : wifiAvailable
      ? ''
      : 'Wi-Fi details are not configured on the service yet. Please contact support.';
  const packageResult = await db.query(
    `select p.id, p.name, p.price, p.duration, p.bandwidth, p.data,
            exists (
              select 1 from vouchers v
              where v.package_id = p.id and v.status = 'AVAILABLE'
            ) as available
     from packages p
     order by p.price asc, p.id asc`
  );
  const linkedStatus = String(client.linked_order_status || '').toUpperCase();
  const pendingRenewal = client.linked_payment_provider === 'COURTNEYTECH' && ['INITIATING', 'PENDING'].includes(linkedStatus)
    ? {
        orderId: client.order_id,
        checkoutRequestId: client.linked_checkout_id || null,
        packageName: client.linked_package_name || 'Selected package',
        amount: Number(client.linked_amount || 0),
        state: linkedStatus === 'PENDING' ? 'pending' : 'initiating',
      }
    : null;

  return {
    subscriber: {
      name: client.customer_name || 'Outdoor Wi-Fi subscriber',
      phone: maskedPhone,
      packageName: client.package_name,
      packagePrice: client.package_price,
      purchasedAt: paidAt || client.created_at,
      purchaseTimeSource: paidAt ? 'payment' : 'subscription-record',
      activatedAt: client.activation_at,
      expiresAt: client.expected_expiry_at,
      remainingMs: Math.max(0, expiresAt - timestamp),
      status: subscriberStatus,
    },
    packages: packageResult.rows,
    supportPhone: SUPPORT_PHONE,
    wifi: {
      available: wifiAvailable,
      ssid: wifiAvailable ? wifiSsid : '',
      authentication: String(process.env.OUTDOOR_WIFI_AUTHENTICATION || 'WPA2/WPA3-PSK'),
      password: wifiAvailable ? wifiPassword : '',
      message: wifiMessage,
    },
    pendingRenewal,
  };
}

function createOutdoorPortalRouter({
  db,
  sendSms = sendTextSms,
  normalizePhone = normalizeKenyanPhone,
  getStatus = deriveStatus,
  now = Date.now,
  createCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
  courtneyClient = createCourtneyTechClient(),
  sessionSecret = sessionSigningSecret,
} = {}) {
  const router = express.Router();
  const challenges = new Map();
  const requestHistory = new Map();

  function requirePortalSession(req, res, next) {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    const session = match ? readPortalSessionToken(match[1], now(), sessionSecret) : null;
    if (!session) return res.status(401).json({ error: 'PORTAL_SESSION_EXPIRED', message: 'Your secure portal session expired. Verify your phone again.' });
    req.portalSession = session;
    return next();
  }

  function pruneExpiredState(timestamp) {
    if (challenges.size > 1000) {
      for (const [phone, challenge] of challenges) {
        if (challenge.expiresAt <= timestamp) challenges.delete(phone);
      }
    }
    if (requestHistory.size > 1000) {
      for (const [phone, requests] of requestHistory) {
        const recent = requests.filter((requestedAt) => timestamp - requestedAt < 60 * 60 * 1000);
        if (recent.length) requestHistory.set(phone, recent);
        else requestHistory.delete(phone);
      }
    }
  }

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/request-code', async (req, res) => {
    let phone;
    try {
      phone = normalizePhone(req.body?.phone);
    } catch {
      return res.status(400).json({ error: 'INVALID_PHONE', message: 'Enter the Kenyan mobile number used for your Outdoor Wi-Fi subscription.' });
    }

    const timestamp = now();
    pruneExpiredState(timestamp);
    if (requestHistory.size >= 10000 && !requestHistory.has(phone)) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Please wait before requesting another code.' });
    }
    const recentRequests = (requestHistory.get(phone) || []).filter((requestedAt) => timestamp - requestedAt < 60 * 60 * 1000);
    if (recentRequests.length >= OTP_MAX_REQUESTS_PER_HOUR || (recentRequests.length && timestamp - recentRequests[recentRequests.length - 1] < OTP_RESEND_MS)) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Please wait before requesting another code.' });
    }
    recentRequests.push(timestamp);
    requestHistory.set(phone, recentRequests);

    try {
      const subscriber = await findSubscriber(db, phone);
      challenges.delete(phone);
      if (subscriber.rowCount) {
        const code = createCode();
        challenges.set(phone, { hash: hashCode(phone, code), expiresAt: timestamp + OTP_TTL_MS, attempts: 0 });
        try {
          await sendSms({
            phone,
            message: `Your SUPA LAN Outdoor Wi-Fi portal code is ${code}. It expires in 5 minutes. Do not share this code.`,
          });
        } catch (error) {
          challenges.delete(phone);
          console.error('[OUTDOOR_PORTAL_OTP] SMS delivery failed:', error.code || 'provider-error');
        }
      }
      return res.status(202).json({ message: 'If an Outdoor Wi-Fi subscription matches that number, a verification code has been sent.' });
    } catch (error) {
      console.error('[OUTDOOR_PORTAL_OTP] Subscriber lookup failed:', error.code || 'database-error');
      return res.status(500).json({ error: 'PORTAL_UNAVAILABLE', message: 'The portal is temporarily unavailable. Please try again shortly.' });
    }
  });

  router.post('/verify-code', async (req, res) => {
    let phone;
    const code = String(req.body?.code || '').trim();
    try {
      phone = normalizePhone(req.body?.phone);
    } catch {
      return res.status(400).json({ error: 'INVALID_CODE', message: 'The phone number or code is incorrect or expired.' });
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'INVALID_CODE', message: 'The phone number or code is incorrect or expired.' });
    }

    const challenge = challenges.get(phone);
    const timestamp = now();
    if (!challenge || challenge.expiresAt <= timestamp || challenge.attempts >= OTP_MAX_ATTEMPTS) {
      challenges.delete(phone);
      return res.status(400).json({ error: 'INVALID_CODE', message: 'The phone number or code is incorrect or expired.' });
    }

    if (!constantTimeEqual(challenge.hash, hashCode(phone, code))) {
      challenge.attempts += 1;
      if (challenge.attempts >= OTP_MAX_ATTEMPTS) challenges.delete(phone);
      return res.status(400).json({ error: 'INVALID_CODE', message: 'The phone number or code is incorrect or expired.' });
    }

    challenges.delete(phone);

    try {
      const matchingClient = await db.query(
        `select c.id
         from outdoor_wifi_clients c
         where regexp_replace(c.phone, '[^0-9]', '', 'g') = any($1::text[])
           and c.status <> 'CANCELLED'
         order by (c.expected_expiry_at > now()) desc, c.expected_expiry_at desc, c.updated_at desc
         limit 1`,
        [phoneVariants(phone)]
      );
      if (!matchingClient.rowCount) {
        return res.status(400).json({ error: 'INVALID_CODE', message: 'The phone number or code is incorrect or expired.' });
      }

      const portalData = await loadPortalData({
        db,
        clientId: matchingClient.rows[0].id,
        normalizePhone,
        getStatus,
        timestamp,
      });
      if (!portalData) return res.status(400).json({ error: 'INVALID_CODE', message: 'The phone number or code is incorrect or expired.' });
      return res.json({
        ...portalData,
        sessionToken: createPortalSessionToken(matchingClient.rows[0].id, timestamp, sessionSecret),
      });
    } catch (error) {
      console.error('[OUTDOOR_PORTAL] Subscriber details lookup failed:', error.code || 'database-error');
      return res.status(500).json({ error: 'PORTAL_UNAVAILABLE', message: 'We could not load your subscription right now. Please try again shortly.' });
    }
  });

  router.post('/renewals/start', requirePortalSession, async (req, res) => {
    const packageId = String(req.body?.packageId || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(packageId)) {
      return res.status(400).json({ error: 'INVALID_PACKAGE', message: 'Choose a valid package to renew.' });
    }
    if (!courtneyClient.isConfigured()) {
      return res.status(503).json({ error: 'PAYMENT_NOT_CONFIGURED', message: 'M-Pesa renewals are not configured yet. Please contact support.' });
    }

    const connection = await db.connect();
    let transactionOpen = false;
    let renewal;
    try {
      await connection.query('begin');
      transactionOpen = true;
      const clientResult = await connection.query(
        `select c.id, c.phone, c.order_id,
                linked_order.status as linked_order_status,
                linked_order.payment_provider as linked_payment_provider,
                linked_order.provider_checkout_id,
                linked_order.amount as linked_amount,
                linked_package.name as linked_package_name
         from outdoor_wifi_clients c
         left join orders linked_order on linked_order.id = c.order_id
         left join packages linked_package on linked_package.id = linked_order.package_id
         where c.id = $1 and c.status <> 'CANCELLED'
         for update of c`,
        [req.portalSession.clientId]
      );
      if (!clientResult.rowCount) {
        await connection.query('rollback');
        transactionOpen = false;
        return res.status(404).json({ error: 'SUBSCRIPTION_NOT_FOUND', message: 'This subscription is no longer available. Please contact support.' });
      }

      const client = clientResult.rows[0];
      const linkedStatus = String(client.linked_order_status || '').toUpperCase();
      if (client.linked_payment_provider === 'COURTNEYTECH' && ['INITIATING', 'PENDING'].includes(linkedStatus)) {
        await connection.query('commit');
        transactionOpen = false;
        if (!client.provider_checkout_id) {
          return res.status(409).json({ error: 'RENEWAL_STARTING', message: 'Your previous M-Pesa request is still being prepared. Please try again in a few seconds.' });
        }
        return res.json({
          orderId: client.order_id,
          status: 'pending',
          checkoutRequestId: client.provider_checkout_id,
          packageName: client.linked_package_name || 'Selected package',
          amount: Number(client.linked_amount || 0),
        });
      }

      const packageResult = await connection.query(
        `select p.id, p.name, p.price, p.duration,
                exists (select 1 from vouchers v where v.package_id = p.id and v.status = 'AVAILABLE') as available
         from packages p
         where p.id = $1
         limit 1`,
        [packageId]
      );
      if (!packageResult.rowCount) {
        await connection.query('rollback');
        transactionOpen = false;
        return res.status(404).json({ error: 'PACKAGE_NOT_FOUND', message: 'That package is no longer available.' });
      }
      const plan = packageResult.rows[0];
      const amount = Number(plan.price);
      if (!plan.available || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_PAYMENT_AMOUNT_KES) {
        await connection.query('rollback');
        transactionOpen = false;
        return res.status(409).json({ error: 'PACKAGE_UNAVAILABLE', message: 'That package is currently unavailable. Please choose another plan.' });
      }
      if (!packageDurationMs(plan.duration)) {
        await connection.query('rollback');
        transactionOpen = false;
        console.error('[OUTDOOR_PORTAL_RENEWAL] Unsupported package duration in catalog.');
        return res.status(409).json({ error: 'PACKAGE_DURATION_UNSUPPORTED', message: 'That package cannot be renewed online yet. Please contact support.' });
      }

      let phone;
      try {
        phone = normalizePhone(client.phone);
      } catch {
        await connection.query('rollback');
        transactionOpen = false;
        return res.status(409).json({ error: 'INVALID_SUBSCRIBER_PHONE', message: 'We could not verify the subscription phone. Please contact support.' });
      }

      const orderId = crypto.randomUUID();
      const reference = `OW${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      await connection.query(
        `insert into orders (id, reference, package_id, amount, phone, status, payment_provider, created_at, updated_at)
         values ($1,$2,$3,$4,$5,'INITIATING','COURTNEYTECH',now(),now())`,
        [orderId, reference, plan.id, amount, phone]
      );
      await connection.query('update outdoor_wifi_clients set order_id=$2, updated_at=now() where id=$1', [client.id, orderId]);
      await connection.query('commit');
      transactionOpen = false;
      renewal = { orderId, reference, clientId: client.id, packageId: plan.id, packageName: plan.name, duration: plan.duration, amount, phone };
    } catch (error) {
      if (transactionOpen) await connection.query('rollback').catch(() => {});
      console.error('[OUTDOOR_PORTAL_RENEWAL] Could not create payment order:', error.code || 'database-error');
      return res.status(500).json({ error: 'RENEWAL_UNAVAILABLE', message: 'We could not start your renewal. Please try again shortly.' });
    } finally {
      connection.release();
    }

    try {
      const payment = await courtneyClient.startStk({
        phone: renewal.phone,
        amount: renewal.amount,
        reference: renewal.reference,
        description: 'Outdoor renew',
        callbackUrl: COURTNEY_CALLBACK_URL,
      });
      await db.query(
        `update orders
         set status='PENDING', provider_checkout_id=$2, provider_request_id=$3,
             provider_transaction_id=$4, updated_at=now()
         where id=$1 and status='INITIATING'`,
        [renewal.orderId, payment.checkoutRequestId, payment.merchantRequestId, payment.transactionId]
      );
      return res.json({
        orderId: renewal.orderId,
        status: 'pending',
        checkoutRequestId: payment.checkoutRequestId,
        packageName: renewal.packageName,
        amount: renewal.amount,
      });
    } catch (error) {
      await db.query(`update orders set status='FAILED', updated_at=now() where id=$1 and status='INITIATING'`, [renewal.orderId]).catch(() => {});
      console.error('[OUTDOOR_PORTAL_RENEWAL] CourtneyTech STK request failed:', error.code || 'provider-error');
      return res.status(error.statusCode || 502).json({
        error: error.code || 'PAYMENT_START_FAILED',
        message: error.message || 'We could not send the M-Pesa prompt. Please try again later.',
      });
    }
  });

  router.post('/renewals/status', requirePortalSession, async (req, res) => {
    const orderId = String(req.body?.orderId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) {
      return res.status(400).json({ error: 'INVALID_RENEWAL', message: 'The renewal request could not be found.' });
    }

    try {
      const result = await db.query(
        `select o.id, o.reference, o.status, o.payment_provider, o.provider_checkout_id,
                o.amount, o.phone, o.mpesa_receipt, p.id as package_id, p.name as package_name, p.duration
         from outdoor_wifi_clients c
         join orders o on o.id = c.order_id
         join packages p on p.id = o.package_id
         where c.id = $1 and o.id = $2 and o.payment_provider = 'COURTNEYTECH'
         limit 1`,
        [req.portalSession.clientId, orderId]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'RENEWAL_NOT_FOUND', message: 'This renewal request is no longer available.' });
      const order = result.rows[0];
      const localStatus = String(order.status || '').toUpperCase();
      if (localStatus === 'PAID') {
        const portalData = await loadPortalData({ db, clientId: req.portalSession.clientId, normalizePhone, getStatus, timestamp: now() });
        return res.json({ status: 'completed', receipt: order.mpesa_receipt, ...(portalData || {}) });
      }
      if (localStatus === 'FAILED' || localStatus === 'CANCELLED') {
        return res.json({ status: localStatus.toLowerCase() });
      }
      if (localStatus === 'INITIATING' || !order.provider_checkout_id) {
        return res.json({ status: 'initiating' });
      }

      const provider = await courtneyClient.checkStatus(order.provider_checkout_id);
      if (provider.checkoutRequestId && provider.checkoutRequestId !== order.provider_checkout_id) {
        return res.status(409).json({ error: 'PAYMENT_REFERENCE_MISMATCH', message: 'Payment status could not be verified. Please contact support.' });
      }
      if (provider.status === 'pending') return res.json({ status: 'pending' });

      if (provider.status === 'failed' || provider.status === 'cancelled') {
        const finalStatus = provider.status === 'cancelled' ? 'CANCELLED' : 'FAILED';
        await db.query(`update orders set status=$2, updated_at=now() where id=$1 and status='PENDING'`, [order.id, finalStatus]);
        return res.json({ status: provider.status });
      }

      const providerPhone = normalizePhone(provider.phone);
      const amountMatches = Number(provider.amount) === Number(order.amount);
      const phoneMatches = providerPhone === normalizePhone(order.phone);
      const referenceMatches = !provider.reference || provider.reference === order.reference;
      if (!amountMatches || !phoneMatches || !referenceMatches || !provider.receipt || (provider.resultCode !== null && String(provider.resultCode) !== '0')) {
        console.error('[OUTDOOR_PORTAL_RENEWAL] CourtneyTech status did not match the pending order.');
        return res.status(409).json({ error: 'PAYMENT_DETAILS_MISMATCH', message: 'Payment confirmation did not match this renewal. Please contact support.' });
      }

      const durationMs = packageDurationMs(order.duration);
      if (!durationMs) return res.status(409).json({ error: 'PACKAGE_DURATION_UNSUPPORTED', message: 'We could not activate this package. Please contact support.' });
      const activationTime = now();
      const expiresAt = new Date(activationTime + durationMs);
      const connection = await db.connect();
      let transactionOpen = false;
      let alreadyPaid = false;
      try {
        await connection.query('begin');
        transactionOpen = true;
        const locked = await connection.query(
          `select o.status, c.blacklist_enabled
           from orders o
           join outdoor_wifi_clients c on c.id=$2 and c.order_id=o.id
           where o.id=$1
           for update of o, c`,
          [order.id, req.portalSession.clientId]
        );
        if (!locked.rowCount) {
          await connection.query('rollback');
          transactionOpen = false;
          return res.status(409).json({ error: 'RENEWAL_CHANGED', message: 'Your subscription changed while payment was processing. Please contact support.' });
        }
        const orderStatus = String(locked.rows[0].status || '').toUpperCase();
        if (orderStatus === 'PAID') {
          alreadyPaid = true;
          await connection.query('commit');
          transactionOpen = false;
        } else if (orderStatus !== 'PENDING') {
          await connection.query('rollback');
          transactionOpen = false;
          return res.status(409).json({ error: 'RENEWAL_NOT_PENDING', message: 'This renewal is no longer pending.' });
        } else {
          const paid = await connection.query(
            `update orders
             set status='PAID', provider_transaction_id=coalesce($2, provider_transaction_id),
                 mpesa_receipt=$3, paid_at=coalesce(paid_at,now()), updated_at=now()
             where id=$1 and status='PENDING'
             returning id`,
            [order.id, provider.transactionId, provider.receipt]
          );
          if (!paid.rowCount) throw new Error('Renewal order could not be marked paid.');
          const updated = await connection.query(
            `update outdoor_wifi_clients
             set package_id=$2, package_name=$3, package_price=$4,
                 activation_at=$5, expected_expiry_at=$6, order_reference=$8,
                 status=case when blacklist_enabled then 'BLACKLISTED' else 'ACTIVE' end,
                 action_required_at=case when blacklist_enabled then action_required_at else null end,
                 updated_at=now()
             where id=$1 and order_id=$7
             returning id`,
            [req.portalSession.clientId, order.package_id, order.package_name, order.amount, new Date(activationTime).toISOString(), expiresAt.toISOString(), order.id, order.reference]
          );
          if (!updated.rowCount) throw new Error('Subscriber record changed before renewal activation.');
          await connection.query('commit');
          transactionOpen = false;
        }
      } catch (error) {
        if (transactionOpen) await connection.query('rollback').catch(() => {});
        throw error;
      } finally {
        connection.release();
      }

      const portalData = await loadPortalData({ db, clientId: req.portalSession.clientId, normalizePhone, getStatus, timestamp: now() });
      return res.json({ status: 'completed', receipt: provider.receipt, alreadyPaid, ...(portalData || {}) });
    } catch (error) {
      console.error('[OUTDOOR_PORTAL_RENEWAL] Status check failed:', error.code || 'provider-or-database-error');
      return res.status(error.statusCode || 502).json({
        error: error.code || 'PAYMENT_STATUS_UNAVAILABLE',
        message: error.message || 'We could not verify your payment. Please try again shortly.',
      });
    }
  });

  return router;
}

module.exports = { createOutdoorPortalRouter, loadPortalData, phoneVariants, packageDurationMs };
