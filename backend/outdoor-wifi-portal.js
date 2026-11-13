const crypto = require('node:crypto');
const express = require('express');
const { normalizeKenyanPhone, sendTextSms } = require('./textsms');
const { deriveStatus } = require('./outdoor-wifi');

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const OTP_MAX_REQUESTS_PER_HOUR = 4;
const OTP_MAX_ATTEMPTS = 5;
const SUPPORT_PHONE = '0113313240';
const challengeSecret = crypto.randomBytes(32);

function hashCode(phone, code) {
  return crypto.createHmac('sha256', challengeSecret).update(`${phone}:${code}`).digest();
}

function constantTimeEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function phoneVariants(phone) {
  return [phone, `0${phone.slice(3)}`];
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

function createOutdoorPortalRouter({
  db,
  sendSms = sendTextSms,
  normalizePhone = normalizeKenyanPhone,
  getStatus = deriveStatus,
  now = Date.now,
  createCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
} = {}) {
  const router = express.Router();
  const challenges = new Map();
  const requestHistory = new Map();

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
      const result = await db.query(
        `select c.id, c.customer_name, c.phone, c.package_name, c.package_price,
                c.activation_at, c.expected_expiry_at, c.status, c.blacklist_enabled,
                c.created_at, o.paid_at
         from outdoor_wifi_clients c
         left join orders o on o.id = c.order_id
         where regexp_replace(c.phone, '[^0-9]', '', 'g') = any($1::text[])
           and c.status <> 'CANCELLED'
         order by (c.expected_expiry_at > now()) desc, c.expected_expiry_at desc, c.updated_at desc
         limit 1`,
        [phoneVariants(phone)]
      );
      if (!result.rowCount) {
        return res.status(400).json({ error: 'INVALID_CODE', message: 'The phone number or code is incorrect or expired.' });
      }

      const client = result.rows[0];
      const packages = await db.query(
        `select p.id, p.name, p.price, p.duration, p.bandwidth, p.data,
                exists (
                  select 1 from vouchers v
                  where v.package_id = p.id and v.status = 'AVAILABLE'
                ) as available
         from packages p
         order by p.price asc, p.id asc`
      );
      const expiresAt = new Date(client.expected_expiry_at).getTime();
      const purchaseTime = client.paid_at || client.created_at;

      return res.json({
        subscriber: {
          name: client.customer_name || 'Outdoor Wi-Fi subscriber',
          phone: `+254${phone.slice(3, 6)}••••${phone.slice(-2)}`,
          packageName: client.package_name,
          packagePrice: client.package_price,
          purchasedAt: purchaseTime,
          purchaseTimeSource: client.paid_at ? 'payment' : 'subscription-record',
          activatedAt: client.activation_at,
          expiresAt: client.expected_expiry_at,
          remainingMs: Math.max(0, expiresAt - timestamp),
          status: getStatus(client),
        },
        packages: packages.rows,
        supportPhone: SUPPORT_PHONE,
      });
    } catch (error) {
      console.error('[OUTDOOR_PORTAL] Subscriber details lookup failed:', error.code || 'database-error');
      return res.status(500).json({ error: 'PORTAL_UNAVAILABLE', message: 'We could not load your subscription right now. Please try again shortly.' });
    }
  });

  return router;
}

module.exports = { createOutdoorPortalRouter, phoneVariants };
