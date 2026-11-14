const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env.development.local') });

const { sendTextSms, normalizeKenyanPhone } = require('./textsms');
const { sendPurchaseConfirmation, sendAdminPurchaseAlert, queueFreeAccessConfirmation, validateTemplate, validateFreeAccessTemplate, DEFAULT_TEMPLATE, EVENT_TYPE, FREE_ACCESS_EVENT_TYPE, FREE_ACCESS_DEFAULT_TEMPLATE } = require('./sms-notifications');
const { startFreeAccessSmsWorker, runFreeAccessSmsWorker } = require('./free-access-sms-worker');
const { createAndScheduleExpiry, startExpiryScheduler } = require('./expiry-alerts');
const { associateOrderCustomer } = require('./customer-contacts');
const { normalizeMac, deriveStatus, getOutdoorMessage, sendOutdoorSms, processOutdoorWifiExpiry, logOutdoorWifiSmsConfig, STATUSES, OUTDOOR_TEMPLATES } = require('./outdoor-wifi');
const { createOutdoorPortalRouter } = require('./outdoor-wifi-portal');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const rootDir = path.join(__dirname, '..');
const testMode = (process.env.TEST_MODE || 'true').toLowerCase() === 'true' || process.env.TEST_MODE === '1';
const portalUrl = process.env.MYPUBLICWIFI_PORTAL_URL || 'http://192.168.10.1/';
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;

if (!databaseUrl) {
  throw new Error('Database configuration is missing. Set DATABASE_URL, POSTGRES_URL, or POSTGRES_PRISMA_URL.');
}

const db = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('supabase') || databaseUrl.includes('neon.tech')
    ? { rejectUnauthorized: false }
    : false
});

async function ensureExpirySchema() {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(`
      alter table expiry_message_templates
        add column if not exists rule_id bigint references expiry_rules(id) on delete cascade;
      alter table expiry_events
        add column if not exists rule_id bigint references expiry_rules(id) on delete set null;
      alter table expiry_message_templates
        drop constraint if exists expiry_message_templates_event_type_key;
    `);
    await client.query(`
      update expiry_events e
      set rule_id = r.id
      from expiry_rules r
      where e.rule_id is null
        and e.event_type = r.event_type
        and e.reminder_offset_minutes = r.offset_minutes
    `);
    await client.query(`
      insert into expiry_message_templates (rule_id, event_type, template_text, enabled, updated_by)
      select r.id, r.event_type,
        case when r.event_type = 'EXPIRY_EXPIRED'
          then 'SUPA LAN: Your {{package}} package has expired. Purchase another package to continue browsing.'
          else 'SUPA LAN: Your {{package}} package expires in {{remaining_time}} at {{expiry_time}}. Renew your package to continue browsing.'
        end,
        true, 'schema-guard'
      from expiry_rules r
      where not exists (
        select 1 from expiry_message_templates t where t.rule_id = r.id
      )
    `);
    await client.query(`
      create table if not exists sms_admin_settings (
        id boolean primary key default true,
        admin_phone text,
        updated_at timestamptz not null default now(),
        updated_by text
      );
      insert into sms_admin_settings (id) values (true) on conflict (id) do nothing;
      create unique index if not exists idx_expiry_message_templates_rule_id
        on expiry_message_templates(rule_id) where rule_id is not null;
      create index if not exists idx_expiry_events_rule_id
        on expiry_events(status, rule_id, scheduled_for)
    `);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    console.error('[EXPIRY SCHEMA]', error.message);
    throw error;
  } finally {
    client.release();
  }
}

const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({ origin: (requestOrigin, callback) => {
  if (!corsOrigins.length) return callback(null, '*');
  return callback(null, corsOrigins.includes(requestOrigin) ? requestOrigin : false);
} }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/outdoor-wifi/portal', createOutdoorPortalRouter({ db }));

app.use(express.static(rootDir));

app.get('/outdoor-wifi', (req, res) => {
  res.sendFile(path.join(rootDir, 'outdoor-wifi.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(rootDir, 'login.html'));
});

app.get('/admin/expiry', (req, res) => {
  res.sendFile(path.join(rootDir, 'admin-expiry.html'));
});

app.get('/admin/outdoor-wifi', (req, res) => {
  res.sendFile(path.join(rootDir, 'admin-outdoor-wifi.html'));
});

app.get('/api/admin/outdoor-wifi/clients', requireAdmin, async (req, res) => {
  try {
    await processOutdoorWifiExpiry(db);
    const result = await db.query(`select c.*, e.status as action_event_status, e.error_message as action_event_error, o.reference as renewal_reference, o.payment_provider as renewal_payment_provider, o.status as renewal_payment_status, o.paid_at as renewal_paid_at, o.mpesa_receipt as renewal_mpesa_receipt from outdoor_wifi_clients c left join outdoor_wifi_action_events e on e.client_id=c.id and e.event_type='ACTION_REQUIRED' left join orders o on o.id=c.order_id where c.status <> 'CANCELLED' order by c.expected_expiry_at asc`);
    const clients = result.rows.map((row) => ({ ...row, status: deriveStatus(row) }));
    const filter = String(req.query.status || '').toUpperCase();
    const search = String(req.query.search || '').trim().toLowerCase();
    const filtered = clients.filter((client) => (!STATUSES.has(filter) || client.status === filter) && (!search || [client.customer_name, client.phone, client.mac_address, client.voucher_code, client.order_reference].some((value) => String(value || '').toLowerCase().includes(search))));
    return res.json({ clients: filtered, summary: Object.fromEntries([...STATUSES].map((status) => [status, clients.filter((client) => client.status === status).length])) });
  } catch (error) { console.error('GET outdoor Wi-Fi clients:', error.message); return res.status(500).json({ error: 'OUTDOOR_WIFI_LIST_FAILED', message: 'Unable to load Outdoor Wi-Fi clients.' }); }
});

app.post('/api/admin/outdoor-wifi/clients', requireAdmin, async (req, res) => {
  const body = req.body || {};
  if (!body.package_name || !body.activation_at || !body.expected_expiry_at) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Package, activation time, and expected expiry are required.' });
  let phone; let mac;
  try { phone = normalizeKenyanPhone(body.phone); mac = normalizeMac(body.mac_address); } catch (error) { return res.status(400).json({ error: 'VALIDATION_ERROR', message: error.message }); }
  const parseKenyaDateTime = (value) => {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(text)) return new Date(NaN);
    return new Date(`${text}${text.length === 16 ? ':00' : ''}+03:00`);
  };
  const activation = parseKenyaDateTime(body.activation_at); const expiry = parseKenyaDateTime(body.expected_expiry_at);
  if (Number.isNaN(activation.getTime()) || Number.isNaN(expiry.getTime()) || expiry <= activation) return res.status(400).json({ error: 'INVALID_TIMING', message: 'Enter valid Nairobi time values, with expected expiry after activation.' });
  try {
    const result = await db.query(`insert into outdoor_wifi_clients (order_id, package_id, customer_name, phone, package_name, package_price, voucher_code, order_reference, mac_address, wifi_credentials_issued, airtel_mac_rule_added, blacklist_enabled, activation_at, expected_expiry_at, status, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`, [body.order_id || null, body.package_id || null, body.customer_name || null, phone, body.package_name, body.package_price || null, body.voucher_code || null, body.order_reference || null, mac, body.wifi_credentials_issued === true, body.airtel_mac_rule_added === true, body.blacklist_enabled === true, activation, expiry, body.blacklist_enabled === true ? 'BLACKLISTED' : deriveStatus({ expected_expiry_at: expiry, blacklist_enabled: false }), body.notes || null]);
    const client = result.rows[0];
    let sms;
    try {
      const message = await getOutdoorMessage(db, 'OUTDOOR_WIFI_CLIENT_CREATED', client);
      sms = await sendOutdoorSms(db, client, 'OUTDOOR_WIFI_CLIENT_CREATED', client.phone, message);
    } catch (error) {
      console.error('[OUTDOOR_WIFI_ADMIN_CREATE] Client saved but notification failed:', JSON.stringify({
        code: error.code || 'notification-error',
        constraint: error.constraint || null,
        table: error.table || null,
      }));
      sms = { attempted: false, status: 'FAILED', error: 'Client was saved, but its notification could not be completed.' };
    }
    return res.status(201).json({ client, sms });
  } catch (error) { if (error.code === '23505') { const existing = await db.query('select id, status from outdoor_wifi_clients where mac_address=$1 order by updated_at desc limit 1', [mac]); const current = existing.rows[0]; if (current) { const updated = await db.query(`update outdoor_wifi_clients set order_id=$2, package_id=$3, customer_name=$4, phone=$5, package_name=$6, package_price=$7, voucher_code=$8, order_reference=$9, wifi_credentials_issued=$10, airtel_mac_rule_added=$11, blacklist_enabled=false, blacklist_enabled_at=null, blacklist_enabled_by=null, activation_at=$12, expected_expiry_at=$13, status='ACTIVE', notes=$14, action_required_at=null, updated_at=now() where id=$1 returning *`, [current.id, body.order_id || null, body.package_id || null, body.customer_name || null, phone, body.package_name, body.package_price || null, body.voucher_code || null, body.order_reference || null, Boolean(body.wifi_credentials_issued), Boolean(body.airtel_mac_rule_added), activation, expiry, body.notes || null]); const client = updated.rows[0]; const sms = await sendOutdoorSms(db, client, 'OUTDOOR_WIFI_CLIENT_UPDATED', client.phone, await getOutdoorMessage(db, 'OUTDOOR_WIFI_CLIENT_UPDATED', client)); return res.status(200).json({ client, sms, updatedExisting: true, message: 'The existing client using this MAC address was updated.' }); } return res.status(409).json({ error: 'DUPLICATE_MAC', message: 'An active client already uses this MAC address.' }); } console.error('[OUTDOOR_WIFI_ADMIN_CREATE] Client insert failed:', JSON.stringify({ code: error.code || 'database-error', constraint: error.constraint || null, table: error.table || null, column: error.column || null })); return res.status(500).json({ error: 'OUTDOOR_WIFI_CREATE_FAILED', message: error.code === '23514' ? 'The database rejected one of the client details (23514).' : 'Unable to create client.' }); }
});

app.post('/api/admin/outdoor-wifi/clients/:id/blacklist-enabled', requireAdmin, async (req, res) => {
  try { const result = await db.query(`update outdoor_wifi_clients set blacklist_enabled=true, blacklist_enabled_at=now(), blacklist_enabled_by=$2, status='BLACKLISTED', updated_at=now() where id=$1 and status='ACTION_REQUIRED' returning *`, [req.params.id, req.body?.admin || 'admin']); if (!result.rowCount) return res.status(409).json({ error: 'NOT_ACTION_REQUIRED', message: 'Only expired clients awaiting action can be completed.' }); await db.query(`update outdoor_wifi_action_events set status='COMPLETED', completed_at=now() where client_id=$1 and event_type='ACTION_REQUIRED'`, [req.params.id]); return res.json({ client: result.rows[0] }); } catch (error) { return res.status(500).json({ error: 'BLACKLIST_CONFIRM_FAILED', message: 'Unable to record blacklist completion.' }); }
});

app.get('/api/admin/outdoor-wifi/sms-status', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(`select id, recipient, message_type, status, message, error_message, provider_message_id, created_at, sent_at from sms_messages where source='outdoor-wifi' order by created_at desc limit 30`);
    return res.json({ messages: result.rows });
  } catch (error) {
    console.error('GET outdoor Wi-Fi SMS status:', error.message);
    return res.status(500).json({ error: 'OUTDOOR_WIFI_SMS_STATUS_FAILED', message: 'Unable to load Outdoor Wi-Fi SMS status.' });
  }
});

app.get('/api/config', (req, res) => {
  return res.json({ portalUrl });
});

app.get('/api/health', async (req, res) => {
  let dbStatus = 'unknown';

  try {
    await db.query('select 1 as ok');
    dbStatus = 'connected';
  } catch (err) {
    dbStatus = 'disconnected';
  }

  return res.json({
    status: 'ok',
    service: 'ANONYMIKECONNECT SUPA LAN',
    provider: process.env.PAYMENT_PROVIDER || 'TEST',
    testMode,
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/packages', async (req, res) => {
  try {
    const result = await db.query(`
      select
        p.id,
        p.name,
        p.price,
        p.duration,
        p.bandwidth,
        p.data,
        p.label,
        count(v.id) filter (where v.status = 'AVAILABLE')::int as available_vouchers,
        (count(v.id) filter (where v.status = 'AVAILABLE') > 0) as available
      from packages p
      left join vouchers v on v.package_id = p.id
      group by p.id, p.name, p.price, p.duration, p.bandwidth, p.data, p.label
      order by p.id asc
    `);

    return res.json({
      packages: result.rows,
      testMode,
      source: 'supabase/postgres packages table',
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('GET /api/packages error:', err.message);
    return res.status(500).json({ error: 'PACKAGE_LIST_FAILED', message: 'Unable to read package list from Supabase.' });
  }
});

function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return null;
  }

  let cleaned = phone.replace(/\s|\-/g, '').trim();
  if (!/^\+?[0-9]{9,13}$/.test(cleaned)) {
    return null;
  }

  if (cleaned.startsWith('+254')) {
    return '254' + cleaned.slice(4);
  }

  if (cleaned.startsWith('254')) {
    return cleaned;
  }

  if (cleaned.startsWith('0')) {
    return '254' + cleaned.slice(1);
  }

  return cleaned;
}

  function normalizePalPlussState(status) {
  const map = {
    SUCCESS: 'PAID',
    SUCCESSFUL: 'PAID',
    COMPLETED: 'PAID',
    COMPLETE: 'PAID',
    CONFIRMED: 'PAID',
    SUCCEEDED: 'PAID',
    PAID: 'PAID',
    FAILED: 'FAILED',
    FAILURE: 'FAILED',
    CANCELLED: 'FAILED',
    CANCELED: 'FAILED',
    EXPIRED: 'EXPIRED'
  };

  return map[String(status || '').trim().toUpperCase()] || 'PENDING';
  }

function getDefaultCallbackUrl() {
  if (process.env.CALLBACK_URL) {
    return process.env.CALLBACK_URL;
  }

  if (process.env.PALPLUSS_CALLBACK_URL) {
    return process.env.PALPLUSS_CALLBACK_URL;
  }

  return 'https://supalan.anonymiketech.space/api/webhooks/palpluss';
}

function isValidCallbackUrl(value) {
  try {
    const url = new URL(value);
    const isPrivateHost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(url.hostname);
    const isWebhookPath = url.pathname === '/api/webhooks/palpluss';
    if (isPrivateHost || !isWebhookPath) return false;
    return url.protocol === 'https:' || (testMode && url.protocol === 'http:');
  } catch {
    return false;
  }
}

async function sendPalPlussStk(payload) {
  const provider = (process.env.PAYMENT_PROVIDER || 'TEST').toUpperCase();

  if (provider === 'TEST' || testMode) {
    const transactionId = crypto.randomUUID();
    const providerRequestId = `TEST-${crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;

    return {
      statusCode: 200,
      success: true,
      provider: 'TEST',
      testMode: true,
      data: {
        transactionId,
        tenantId: null,
        channelId: payload.channelId || null,
        type: 'STK',
        status: 'PENDING',
        amount: payload.amount,
        currency: 'KES',
        phone: payload.phone,
        providerRequestId,
        providerCheckoutId: providerRequestId,
        accountReference: payload.accountReference,
        transactionDesc: payload.transactionDesc,
        callbackUrl: payload.callbackUrl
      },
      message: 'TEST MODE: PalPluss STK simulation accepted. No real provider request was executed.'
    };
  }

  if (!process.env.PALPLUSS_BASE_URL || !process.env.PALPLUSS_API_KEY) {
    return {
      statusCode: 503,
      success: false,
      error: 'PAYMENT_API_NOT_READY',
      message: 'PalPluss base URL and API key are not configured.'
    };
  }

  try {
    const base = process.env.PALPLUSS_BASE_URL.replace(/\/$/, '');
    const response = await fetch(`${base}/payments/stk`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + process.env.PALPLUSS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: payload.amount,
        phone: payload.phone,
        accountReference: payload.accountReference,
        transactionDesc: payload.transactionDesc,
        callbackUrl: payload.callbackUrl,
        channelId: payload.channelId || null
      })
    });

    const raw = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        statusCode: response.status,
        success: false,
        error: raw.error || raw,
        requestId: raw.requestId || null
      };
    }

    const transactionId = raw.data?.transaction?.id || raw.data?.transactionId || raw.transactionId || raw.id || null;
    const providerRequestId = raw.data?.transaction?.provider_request_id || raw.data?.providerRequestId || raw.providerRequestId || null;
    const providerCheckoutId = raw.data?.transaction?.provider_checkout_id || raw.data?.providerCheckoutId || raw.providerCheckoutId || null;

    console.info('[PALPLUSS STK CREATED]', JSON.stringify({
      callbackUrl: payload.callbackUrl,
      callbackHttps: payload.callbackUrl.startsWith('https://'),
      accountReference: payload.accountReference,
      transactionIdPresent: Boolean(transactionId),
      providerRequestIdPresent: Boolean(providerRequestId)
    }));

    return {
      statusCode: 200,
      success: true,
      provider: 'PALPLUSS',
      data: raw.data || raw,
      transactionId,
      providerRequestId,
      providerCheckoutId,
      callbackUrl: payload.callbackUrl,
      status: 'PENDING'
    };
  } catch (err) {
    console.error('PalPluss STK helper error:', err.message);
    return {
      statusCode: 500,
      success: false,
      error: 'PALPLUSS_STK_INIT_FAILED',
      message: 'Unable to reach the PalPluss STK endpoint.'
    };
  }
}

app.post('/api/payments/stk', async (req, res) => {
  const body = req.body || {};
  const amount = Number(body.amount || 0);
  const phone = normalizePhone(body.phone || body.phonenumber || body.phone_number);
  const accountReference = String(body.accountReference || body.reference || body.account_reference || '').trim();
  const transactionDesc = String(body.transactionDesc || body.transaction_desc || 'Payment').trim();
  const callbackUrl = String(body.callbackUrl || body.callback_url || getDefaultCallbackUrl()).trim();
  const channelId = body.channelId || body.channel_id || null;

  if (!Number.isInteger(amount) || amount < 1 || !phone || !accountReference || !transactionDesc || !isValidCallbackUrl(callbackUrl)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'amount must be a positive integer, phone and payment references are required, and callbackUrl must be a valid HTTPS URL'
    });
  }

  const result = await sendPalPlussStk({
    amount,
    phone,
    accountReference,
    transactionDesc,
    callbackUrl,
    channelId
  });

  if (!result.success) {
    return res.status(result.statusCode || 500).json({
      success: false,
      error: result.error || 'PAYMENT_FAILED',
      message: result.message || 'Unable to initiate STK request.'
    });
  }

  return res.status(result.statusCode || 200).json(result);
});

app.post('/api/orders', async (req, res) => {
  const packageId = req.body.packageId || req.body.package_id || req.body.package;
  const phone = normalizePhone(req.body.phone);

  if (!packageId || !phone) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'packageId and phone are required'
    });
  }

  try {
    const packageResult = await db.query(
      `select id, name, price, duration, bandwidth, data, label
       from packages
       where id = $1`,
      [packageId]
    );

    if (packageResult.rowCount === 0) {
      return res.status(404).json({
        error: 'PACKAGE_NOT_FOUND',
        message: 'Unknown package selected'
      });
    }

    const pkg = packageResult.rows[0];
    const inventoryResult = await db.query(
      `select count(*)::int as available
       from vouchers
       where package_id = $1 and status = 'AVAILABLE'`,
      [pkg.id]
    );

    if (inventoryResult.rows[0].available < 1) {
      return res.status(409).json({
        error: 'PACKAGE_UNAVAILABLE',
        message: 'This package is currently unavailable. Please choose another package.'
      });
    }

    const reference = `SUPA-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    const provider = (process.env.PAYMENT_PROVIDER || 'PALPLUSS').toUpperCase();

    const orderInsert = await db.query(
      `insert into orders
        (reference, package_id, amount, phone, status, payment_provider, provider_transaction_id, voucher_id, created_at, paid_at, updated_at)
       values
        ($1, $2, $3, $4, 'PENDING', $5, null, null, now(), null, now())
       returning
        id, reference, package_id, amount, phone, status, payment_provider, provider_transaction_id, voucher_id, created_at, paid_at, updated_at`,
      [reference, pkg.id, pkg.price, phone, provider]
    );

    const order = orderInsert.rows[0];

    const callbackUrl = getDefaultCallbackUrl();
    const transactionDesc = `Payment for ${pkg.name}`;

    const stkResult = await sendPalPlussStk({
      amount: pkg.price,
      phone,
      accountReference: order.reference,
      transactionDesc,
      callbackUrl,
      channelId: req.body.channelId || req.body.channel_id || null
    });

    if (!stkResult.success) {
      await db.query(
        `update orders
         set status = 'FAILED',
             payment_provider = $1,
             updated_at = now()
         where id = $2`,
        [provider, order.id]
      );

      return res.status(stkResult.statusCode || 500).json({
        success: false,
        error: stkResult.error || 'PAYMENT_INIT_FAILED',
        message: stkResult.message || 'Unable to initialize PalPluss STK push.'
      });
    }

    const providerRequestId = stkResult.providerRequestId || null;
    const providerCheckoutId = stkResult.providerCheckoutId || null;

    await db.query(
      `update orders
       set payment_provider = $1,
           provider_transaction_id = $2,
           provider_request_id = $3,
           provider_checkout_id = $4,
           updated_at = now()
       where id = $5`,
      [provider, stkResult.transactionId || null, providerRequestId, providerCheckoutId, order.id]
    );

    console.info('[PALPLUSS STK REQUEST]', JSON.stringify({
      callbackUrl,
      callbackHttps: callbackUrl.startsWith('https://'),
      accountReference: order.reference,
      orderId: order.id
    }));

    return res.status(201).json({
      success: true,
      order: {
        id: order.id,
        reference: order.reference,
        package_id: order.package_id,
        package_name: pkg.name,
        amount: order.amount,
        status: order.status,
        created_at: order.created_at,
        message: 'STK Push accepted. Complete the M-PESA prompt on your phone.'
      },
      provider: stkResult.provider || 'PALPLUSS',
      providerRequestId,
      providerCheckoutId: stkResult.providerCheckoutId || null,
      transactionId: stkResult.transactionId || null,
      voucher: null
    });
  } catch (err) {
    console.error('POST /api/orders error:', err.message);
    return res.status(500).json({
      error: 'ORDER_CREATE_FAILED',
      message: 'Unable to create order.'
    });
  }
});

app.get('/api/orders/:id/voucher', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  const idParam = String(req.params.id || '').trim();

  if (!idParam || idParam.length > 120 || !/^[a-zA-Z0-9_-]+$/.test(idParam)) {
    return res.status(400).json({ error: 'INVALID_ORDER_ID', message: 'A valid order ID is required.' });
  }

  const client = await db.connect();
  try {
    await client.query('begin');

    const orderResult = await client.query(
      `select o.id, o.reference, o.package_id, o.amount, o.status, o.voucher_id,
              o.provider_transaction_id, o.provider_request_id, o.provider_checkout_id,
              p.name as package_name, v.code as voucher_code
       from orders o
       join packages p on p.id = o.package_id
       left join vouchers v on v.id = o.voucher_id
       where o.id::text = $1 or o.reference = $1
       limit 1
       for update of o`,
      [idParam]
    );

    if (!orderResult.rowCount) {
      await client.query('rollback');
      return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'Order was not found.' });
    }

    const order = orderResult.rows[0];
    if (!['PAID', 'VOUCHER_ASSIGNED'].includes(order.status)) {
      await client.query('rollback');
      return res.status(order.status === 'FAILED' ? 409 : 200).json({
        error: order.status === 'FAILED' ? 'PAYMENT_NOT_COMPLETED' : 'PAYMENT_PENDING',
        status: order.status,
        providerTransactionId: order.provider_transaction_id || null,
        providerRequestId: order.provider_request_id || null,
        providerCheckoutId: order.provider_checkout_id || null,
        message: order.status === 'FAILED' ? 'Payment was not completed.' : 'Payment verification is in progress.'
      });
    }

    if (order.voucher_id && order.voucher_code) {
      await client.query('commit');
      return res.json({
        status: 'READY',
        orderId: order.id,
        order_id: order.id,
        package: order.package_name,
        package_name: order.package_name,
        amount: order.amount,
        voucher: order.voucher_code
      });
    }

    await client.query('commit');
    return res.status(503).json({
      error: 'VOUCHER_UNAVAILABLE',
      status: 'PAID',
      providerTransactionId: order.provider_transaction_id || null,
      package_name: order.package_name,
      message: 'Payment received, but no voucher was assigned. Please contact support.'
    });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.error('GET /api/orders/:id/voucher error:', err.message);
    return res.status(500).json({ error: 'VOUCHER_LOOKUP_FAILED', message: 'Unable to retrieve your voucher.' });
  } finally {
    client.release();
  }
});

app.get('/api/orders/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  const idParam = req.params.id.trim();

  try {
    const result = await db.query(
      `select
         o.id,
         o.reference,
         o.package_id,
         p.name as package_name,
         o.amount,
         o.status,
         o.payment_provider,
         o.voucher_id,
         v.code as voucher_code,
         o.created_at,
         o.paid_at,
         o.updated_at
       from orders o
       join packages p on p.id = o.package_id
       left join vouchers v on v.id::text = o.voucher_id
       where o.id::text = $1 or o.reference = $1
       limit 1`,
      [idParam]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'Order was not found.' });
    }

    const order = result.rows[0];

    // Only expose the voucher code once the payment is verified and a voucher assigned.
    const voucherCode = order.status === 'VOUCHER_ASSIGNED' && order.voucher_id ? order.voucher_code : null;

    return res.json({
      id: order.id,
      reference: order.reference,
      package_id: order.package_id,
      package_name: order.package_name,
      amount: order.amount,
      status: order.status,
      payment_provider: order.payment_provider,
      voucher_code: voucherCode,
      created_at: order.created_at,
      paid_at: order.paid_at,
      updated_at: order.updated_at
    });
  } catch (err) {
    console.error('GET /api/orders/:id error:', err.message);
    return res.status(500).json({ error: 'ORDER_LOOKUP_FAILED', message: 'Unable to retrieve order status.' });
  }
});

app.post('/api/webhooks/courtneytech', (_req, res) => res.sendStatus(200));

app.post('/api/webhooks/palpluss', async (req, res) => {
  const body = req.body || {};
  const transaction = body.transaction || body.data?.transaction || body.data || body;
  const eventType = String(body.event_type || body.event || body.type || '').toLowerCase();
  const transactionId = transaction.id || transaction.transaction_id || body.transaction_id || null;
  const transactionStatus = String(transaction.status || transaction.payment_status || transaction.state || '').toUpperCase();
  const transactionAmount = Number(transaction.amount ?? transaction.amount_paid ?? body.amount);
  const externalReference = transaction.external_reference || transaction.externalReference || transaction.account_reference || transaction.accountReference || transaction.reference || body.external_reference || body.externalReference || body.accountReference || null;
  const mpesaReceipt = transaction.mpesa_receipt || transaction.mpesaReceipt || transaction.receipt || transaction.receipt_number || null;
  const resultCode = transaction.result_code == null
    ? (transaction.resultCode == null ? null : String(transaction.resultCode))
    : String(transaction.result_code);
  const providerRequestId = transaction.provider_request_id || transaction.providerRequestId || null;
  const providerCheckoutId = transaction.provider_checkout_id || transaction.providerCheckoutId || null;

  console.info('[PALPLUSS CALLBACK RECEIVED]', JSON.stringify({
    event_type: eventType,
    transaction_id: transactionId,
    external_reference: externalReference,
    status: transactionStatus,
    amount: Number.isFinite(transactionAmount) ? transactionAmount : null,
    result_code: resultCode,
    mpesa_receipt_present: Boolean(mpesaReceipt)
  }));

  if (!transactionId || !externalReference || !eventType || !transactionStatus) {
    return res.status(400).json({
      error: 'WEBHOOK_VALIDATION_ERROR',
      message: 'transaction.id and transaction.external_reference are required.'
    });
  }

  const webhookSecret = process.env.PALPLUSS_WEBHOOK_SECRET;
  const receivedSecret = req.get('x-palpluss-webhook-secret') || req.get('x-webhook-secret');
  if (!testMode && webhookSecret && receivedSecret !== webhookSecret) {
    return res.status(401).json({ error: 'WEBHOOK_UNAUTHORIZED', message: 'Webhook authentication failed.' });
  }

  try {
    // Do not use provider_transaction_id as the duplicate guard here. The initial
    // order stores PalPluss provider_request_id, while callbacks identify the
    // transaction with a different UUID. The locked order lookup below is the
    // authoritative idempotency check and also handles callback races safely.
    const isSuccessEvent = ['transaction.success', 'transaction.completed', 'payment.success', 'payment.completed', 'success', 'completed'].includes(eventType);
    const isSuccessStatus = ['SUCCESS', 'COMPLETED', 'PAID'].includes(transactionStatus);
    const isSuccess = isSuccessEvent
      && isSuccessStatus
      && resultCode === '0';
    const status = isSuccess
      ? 'PAID'
      : ['transaction.cancelled', 'payment.cancelled', 'cancelled', 'cancel'].includes(eventType)
        ? 'CANCELLED'
        : ['transaction.expired', 'payment.expired', 'expired'].includes(eventType)
          ? 'EXPIRED'
          : ['transaction.failed', 'payment.failed', 'failed', 'failure'].includes(eventType)
            ? 'FAILED'
            : 'PENDING';
    const amount = transactionAmount;
    const paymentProvider = process.env.PAYMENT_PROVIDER || 'PALPLUSS';
    const providerTransactionId = transactionId;

    // All state changes run inside one transaction with the order row locked,
    // so concurrent or replayed callbacks can never assign more than one voucher.
    const client = await db.connect();
    let assignedVoucherCode = null;
    let finalStatus = status;

    try {
      await client.query('begin');

      const orderResult = await client.query(
        `select id, reference, package_id, amount, phone, voucher_id, status
         from orders
         where reference = $1
         limit 1
         for update`,
        [externalReference]
      );

      if (orderResult.rowCount === 0) {
        await client.query('rollback');
        return res.status(404).json({
          error: 'ORDER_NOT_FOUND',
          message: 'Order reference from PalPluss callback was not found locally.'
        });
      }

      const order = orderResult.rows[0];

      const amountMatch = Number.isFinite(amount) && Number(order.amount) === amount;
      console.info('[PALPLUSS CALLBACK AUDIT]', JSON.stringify({
        order_found: true,
        amount_match: amountMatch,
        order_status_before: order.status
      }));

      if (isSuccess && !amountMatch) {
        await client.query('rollback');
        return res.status(409).json({ error: 'WEBHOOK_AMOUNT_MISMATCH', message: 'Successful callback amount does not match the order.' });
      }

      // Idempotency: once a voucher has been assigned the order is terminal.
      // Re-delivered success callbacks are acknowledged without side effects.
      if (order.voucher_id || order.status === 'VOUCHER_ASSIGNED') {
        await client.query('rollback');
        return res.status(200).json({
          success: true,
          message: 'Order already fulfilled. Duplicate callback ignored.',
          idempotent: true,
          status: 'VOUCHER_ASSIGNED'
        });
      }

      await client.query(
        `update orders
         set status = $1,
             payment_provider = $2,
             provider_transaction_id = $3,
             provider_request_id = coalesce($4, provider_request_id),
             provider_checkout_id = coalesce($5, provider_checkout_id),
             mpesa_receipt = coalesce($6, mpesa_receipt),
             updated_at = now(),
             paid_at = case when $1 = 'PAID' then coalesce(paid_at, now()) else paid_at end
         where id = $7`,
        [status, paymentProvider, providerTransactionId, providerRequestId, providerCheckoutId, mpesaReceipt, order.id]
      );

      // Only a verified successful payment ever leads to voucher assignment.
      if (status === 'PAID') {
        const availableVoucher = await client.query(
          `select id, code
           from vouchers
           where package_id = $1 and status = 'AVAILABLE'
           order by created_at asc
           limit 1
           for update skip locked`,
          [order.package_id]
        );

        if (availableVoucher.rowCount > 0) {
          const voucher = availableVoucher.rows[0];

          const voucherClaim = await client.query(
            `update vouchers
             set status = 'USED',
                 order_id = $1,
                 assigned_at = now(),
                 used_at = null
             where id = $2 and status = 'AVAILABLE'
             returning id, code`,
            [order.id, voucher.id]
          );

          if (voucherClaim.rowCount > 0) {
            const orderClaim = await client.query(
              `update orders
               set voucher_id = $2,
                   status = 'VOUCHER_ASSIGNED',
                   paid_at = coalesce(paid_at, now()),
                   updated_at = now()
               where id = $1 and voucher_id is null
               returning voucher_id`,
              [order.id, voucher.id]
            );

            if (orderClaim.rowCount > 0) {
              assignedVoucherCode = voucherClaim.rows[0].code;
              finalStatus = 'VOUCHER_ASSIGNED';
            } else {
              throw new Error(`Voucher claim could not be attached to order ${order.reference}`);
            }
          }
        } else {
          console.warn(`No AVAILABLE voucher in inventory for package ${order.package_id} (order ${order.reference}).`);
        }
      }

      await client.query('commit');
      console.info('[PALPLUSS CALLBACK FULFILLMENT]', JSON.stringify({
        order_status_after: finalStatus,
        voucher_found: Boolean(assignedVoucherCode),
        voucher_assigned: Boolean(assignedVoucherCode),
        transaction_id: transactionId
      }));

      if (assignedVoucherCode) {
        try {
          const packageResult = await db.query('select name, duration from packages where id = $1 limit 1', [order.package_id]);
          const packageInfo = packageResult.rows[0] || {};
  await sendPurchaseConfirmation({
  db,
  order,
  voucherCode: assignedVoucherCode,
  packageName: packageInfo.name || order.package_id,
  duration: packageInfo.duration
  });
  await sendAdminPurchaseAlert({
  db,
  order,
  voucherCode: assignedVoucherCode,
  packageName: packageInfo.name || order.package_id,
  duration: packageInfo.duration
  });
        } catch (smsError) {
          console.error('[SMS AUTOMATION] Purchase confirmation failed:', smsError.message);
        }
        try {
          const packageResult = await db.query('select name, price, duration from packages where id = $1 limit 1', [order.package_id]);
          const packageInfo = packageResult.rows[0];
          if (packageInfo) await createAndScheduleExpiry({ db, order, packageInfo, voucherCode: assignedVoucherCode });
        } catch (expiryError) {
          console.error('[EXPIRY AUTOMATION] Tracking failed without affecting fulfillment:', expiryError.message);
        }
      }
    } catch (txErr) {
      await client.query('rollback').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    return res.status(200).json({
      success: true,
      message: 'PalPluss webhook accepted and processed.',
      eventType,
      transactionId,
      status: finalStatus,
      voucherAssigned: Boolean(assignedVoucherCode)
    });
  } catch (err) {
    console.error('POST /api/webhooks/palpluss error:', err.message);
    return res.status(500).json({
      error: 'WEBHOOK_PROCESSING_FAILED',
      message: 'Unable to process PalPluss callback.'
    });
  }
});

// Manual Till/Send Money payments stay pending until an authenticated admin confirms them.
app.post('/api/admin/orders/:id/confirm', requireAdmin, async (req, res) => {
  const id = req.params.id.trim();
  const client = await db.connect();
  try {
    await client.query('begin');
    const orderResult = await client.query(`select id, reference, package_id, status, voucher_id from orders where id::text = $1 or reference = $1 for update`, [id]);
    if (!orderResult.rowCount) { await client.query('rollback'); return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'Order was not found.' }); }
    const order = orderResult.rows[0];
    if (String(order.reference || '').startsWith('OW')) { await client.query('rollback'); return res.status(409).json({ error: 'OUTDOOR_RENEWAL_NOT_CONFIRMABLE', message: 'Outdoor Wi-Fi renewals are confirmed by CourtneyTech payment status and cannot be manually confirmed here.' }); }
    if (order.voucher_id) { await client.query('rollback'); return res.json({ success: true, status: 'VOUCHER_ASSIGNED', idempotent: true }); }
    if (['FAILED', 'EXPIRED'].includes(order.status)) { await client.query('rollback'); return res.status(409).json({ error: 'ORDER_NOT_CONFIRMABLE', message: 'Failed or expired orders cannot be confirmed.' }); }
    const voucher = await client.query(`select id, code from vouchers where package_id = $1 and status = 'AVAILABLE' order by created_at asc limit 1 for update skip locked`, [order.package_id]);
    if (!voucher.rowCount) { await client.query(`update orders set status = 'PAID', paid_at = coalesce(paid_at, now()), updated_at = now() where id = $1`, [order.id]); await client.query('commit'); return res.status(409).json({ error: 'INVENTORY_EMPTY', message: 'Payment confirmed, but no matching voucher is available. Support must add inventory.' }); }
    const claimed = await client.query(`update vouchers set status = 'ASSIGNED', order_id = $1, assigned_at = now() where id = $2 and status = 'AVAILABLE' returning id, code`, [order.id, voucher.rows[0].id]);
    await client.query(`update orders set status = 'VOUCHER_ASSIGNED', voucher_id = $2, paid_at = coalesce(paid_at, now()), updated_at = now() where id = $1`, [order.id, claimed.rows[0].id]);
    await client.query('commit');
    return res.json({ success: true, status: 'VOUCHER_ASSIGNED', voucher: { code: claimed.rows[0].code } });
  } catch (err) { await client.query('rollback').catch(() => {}); console.error('POST /api/admin/orders/:id/confirm error:', err.message); return res.status(500).json({ error: 'ORDER_CONFIRM_FAILED', message: 'Unable to confirm order.' }); } finally { client.release(); }
});

// ---------------------------------------------------------------------------
// Isolated MyPublicWiFi free-access SMS automation
// ---------------------------------------------------------------------------
app.post('/api/free-access/challenges', async (req, res) => {
  try {
    const phone = normalizeKenyanPhone(req.body?.phone);
    const voucher = String(req.body?.voucher || '').trim().toUpperCase();
    const sessionMac = String(req.body?.sessionMac || '').trim().toUpperCase();
    if (!['RYRNN', 'KSSSS'].includes(voucher) || !/^[0-9A-F]{12}$/.test(sessionMac.replace(/[:-]/g, ''))) return res.status(400).json({ error: 'INVALID_SESSION_BINDING' });
    const setting = await db.query('select enabled, active_voucher from free_access_settings where id = true');
    if (!setting.rows[0]?.enabled || setting.rows[0].active_voucher !== voucher) return res.status(409).json({ error: 'FREE_ACCESS_DISABLED', message: 'Free access is currently disabled.' });
    const recent = await db.query(`select 1 from free_access_challenges where phone = $1 and consumed_at is null and expires_at > now() limit 1`, [phone]);
    if (recent.rowCount) return res.status(429).json({ error: 'CHALLENGE_RATE_LIMITED', message: 'Please wait before requesting another challenge.' });
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await db.query(`insert into free_access_challenges (token_hash, phone, voucher, session_mac, expires_at) values ($1,$2,$3,$4,now() + interval '5 minutes') returning id, voucher, expires_at`, [tokenHash, phone, voucher, sessionMac.replace(/[:-]/g, '')]);
    return res.status(201).json({ challengeId: result.rows[0].id, challengeToken: token, voucher: result.rows[0].voucher, expiresAt: result.rows[0].expires_at });
  } catch (err) { return res.status(400).json({ error: 'INVALID_FREE_ACCESS_CHALLENGE', message: err.message }); }
});

app.get('/api/free-access/config', async (req, res) => {
  const result = await db.query('select enabled, active_voucher from free_access_settings where id = true');
  return res.json({ enabled: result.rows[0]?.enabled === true, activeVoucher: result.rows[0]?.active_voucher || null });
});

app.post('/api/integrations/mypublicwifi/session', async (req, res) => {
  const secret = process.env.MYPUBLICWIFI_BRIDGE_SECRET || '';
  const expectedBridgeId = process.env.MYPUBLICWIFI_BRIDGE_ID || '';
  const bridgeId = req.get('x-bridge-id') || '';
  const signature = req.get('x-bridge-signature') || '';
  const raw = JSON.stringify(req.body || {});
  if (!secret || !expectedBridgeId) return res.status(503).json({ error: 'BRIDGE_NOT_CONFIGURED' });
  if (!bridgeId || !safeEqual(bridgeId, expectedBridgeId) || !safeEqual(signature, crypto.createHmac('sha256', secret).update(raw).digest('hex'))) return res.status(401).json({ error: 'INVALID_BRIDGE_AUTH' });
  const body = req.body || {};
  if (body.event_type !== 'SESSION_STARTED' || !/^FREE_ACCESS:[A-Z0-9]+:[0-9]+:.+$/.test(body.event_key || '') || !['RYRNN', 'KSSSS'].includes(String(body.voucher || '').toUpperCase()) || !body.mac || !body.start_time || !Number.isInteger(body.account_id)) return res.status(400).json({ error: 'INVALID_SESSION_EVENT' });
  if (Math.abs(Date.now() - Date.parse(body.occurred_at || '')) > 5 * 60 * 1000) return res.status(400).json({ error: 'STALE_SESSION_EVENT' });
  const setting = await db.query('select enabled, active_voucher from free_access_settings where id = true');
  if (!setting.rows[0]?.enabled || setting.rows[0].active_voucher !== String(body.voucher).toUpperCase()) return res.json({ accepted: false, reason: 'VOUCHER_NOT_ACTIVE' });
  const client = await db.connect();
  try {
    await client.query('begin');
    const sessionMac = String(body.mac).replace(/[:-]/g, '').toUpperCase();
    const voucher = String(body.voucher).toUpperCase();
    const accountId = Number(body.account_id);
    const startTime = String(body.start_time).trim();
    const tokenHash = crypto.createHash('sha256').update(String(body.challenge_token || '')).digest('hex');

    // Only this authenticated bridge route may populate AccountID and StartTime.
    // The browser never submits either value, so it cannot invent the session tuple.
    await client.query(`update free_access_challenges
      set account_id = $4, start_time = $5
      where token_hash = $1 and voucher = $2 and session_mac = $3
        and account_id is null and start_time is null
        and consumed_at is null and expires_at > now()`, [tokenHash, voucher, sessionMac, accountId, startTime]);
    const challenge = await client.query(`select id, phone from free_access_challenges
      where token_hash = $1 and voucher = $2 and session_mac = $3
        and account_id = $4 and start_time = $5
        and consumed_at is null and expires_at > now() for update`, [tokenHash, voucher, sessionMac, accountId, startTime]);
    if (!challenge.rowCount) { await client.query('commit'); return res.status(409).json({ accepted: false, reason: 'NO_MATCHING_SESSION_CHALLENGE' }); }
    const eventKey = body.event_key;
    const claimed = await client.query(`update free_access_challenges set consumed_at = now(), event_key = $1 where id = $2 and consumed_at is null returning id, phone`, [eventKey, challenge.rows[0].id]);
    if (!claimed.rowCount) { await client.query('rollback'); return res.json({ accepted: true, delivered: false, duplicate: true }); }
    const sms = await queueFreeAccessConfirmation({ db: client, phone: claimed.rows[0].phone, voucherCode: body.voucher, eventKey });
    await client.query('commit');
    return res.json({ accepted: true, delivered: false, queued: !sms.duplicate, smsStatus: sms.status });
  } catch (err) { await client.query('rollback').catch(() => {}); return res.status(500).json({ error: 'FREE_ACCESS_EVENT_FAILED' }); } finally { client.release(); }
});

// ---------------------------------------------------------------------------
// Admin: voucher inventory management
// ---------------------------------------------------------------------------

// Constant-time comparison so the admin token cannot be guessed via timing.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) {
    return res.status(503).json({
      error: 'ADMIN_NOT_CONFIGURED',
      message: 'ADMIN_TOKEN is not set on the server. Add it in Render environment settings.'
    });
  }

  const provided = req.get('x-admin-token') || '';
  if (!provided || !safeEqual(provided, expected)) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or missing admin token.' });
  }

  return next();
}

app.post('/api/sms/test', requireAdmin, async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message || Object.keys(req.body || {}).some((key) => !['phone', 'message'].includes(key))) {
    return res.status(400).json({ error: 'INVALID_SMS_REQUEST', message: 'Provide only phone and message.' });
  }
  try {
    const result = await sendTextSms({ phone, message });
    return res.json({ success: true, status: 'accepted', messageId: result.messageId });
  } catch (err) {
    console.error('POST /api/sms/test failed:', err.message);
    return res.status(502).json({ error: 'SMS_DELIVERY_FAILED', message: err.message });
  }
});

app.get('/admin/sms', (req, res) => {
  res.sendFile(path.join(rootDir, 'admin-sms.html'));
});

app.get('/api/admin/free-access', requireAdmin, async (req, res) => {
  const result = await db.query('select enabled, active_voucher, updated_at from free_access_settings where id = true');
  return res.json({ enabled: result.rows[0]?.enabled === true, activeVoucher: result.rows[0]?.active_voucher || 'KSSSS', approvedVouchers: ['RYRNN', 'KSSSS'], updatedAt: result.rows[0]?.updated_at || null });
});

app.put('/api/admin/free-access', requireAdmin, async (req, res) => {
  const { enabled, activeVoucher } = req.body || {};
  if (typeof enabled !== 'boolean' || !['RYRNN', 'KSSSS'].includes(activeVoucher)) return res.status(400).json({ error: 'INVALID_FREE_ACCESS_SETTINGS' });
  const result = await db.query(`update free_access_settings set enabled = $1, active_voucher = $2, updated_at = now(), updated_by = 'admin' where id = true returning enabled, active_voucher, updated_at`, [enabled, activeVoucher]);
  return res.json({ settings: result.rows[0] });
});

app.get('/api/admin/bridge/startup-script', requireAdmin, (req, res) => {
  const script = `# SUPA LAN Bridge automatic startup setup
# Run this file once from an elevated PowerShell window.
$ErrorActionPreference = 'Stop'
$taskName = 'SUPA LAN Bridge'
$workingDirectory = 'C:\\Users\\MIKE\\Desktop\\SupaLanBridge-Windows'
$python = (Get-Command py -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command python -ErrorAction SilentlyContinue).Source }
if (-not $python) { throw 'Python 3 was not found. Install Python 3 and try again.' }
$action = New-ScheduledTaskAction -Execute $python -Argument '-3 "C:\\Users\\MIKE\\Desktop\\SupaLanBridge-Windows\\mypublicwifi-bridge.py" --config "C:\\Users\\MIKE\\Desktop\\SupaLanBridge-Windows\\config.json"' -WorkingDirectory $workingDirectory
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Starts the existing SUPA LAN Bridge at Windows startup.' -RunLevel Highest -Force
Start-ScheduledTask -TaskName $taskName
Write-Host 'SUPA LAN Bridge startup task created and started.'
`;
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-disposition', 'attachment; filename="setup-supa-lan-bridge.ps1"');
  return res.send(script);
});

app.get('/api/admin/bridge/remove-script', requireAdmin, (req, res) => {
  const script = `# Remove the SUPA LAN Bridge automatic startup task\nUnregister-ScheduledTask -TaskName 'SUPA LAN Bridge' -Confirm:$false\nWrite-Host 'SUPA LAN Bridge startup task removed.'\n`;
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-disposition', 'attachment; filename="remove-supa-lan-bridge-task.ps1"');
  return res.send(script);
});

app.get('/api/admin/sms/settings', requireAdmin, async (req, res) => {
  const result = await db.query('select admin_phone, updated_at from sms_admin_settings where id = true');
  return res.json({ adminPhone: result.rows[0]?.admin_phone || '', updatedAt: result.rows[0]?.updated_at || null });
});

app.put('/api/admin/sms/settings', requireAdmin, async (req, res) => {
  try {
    const adminPhone = req.body?.adminPhone ? normalizeKenyanPhone(req.body.adminPhone) : '';
    const result = await db.query('update sms_admin_settings set admin_phone = $1, updated_at = now(), updated_by = $2 where id = true returning admin_phone, updated_at', [adminPhone || null, 'admin']);
    return res.json({ adminPhone: result.rows[0]?.admin_phone || '', updatedAt: result.rows[0]?.updated_at || null });
  } catch (error) { return res.status(400).json({ error: 'INVALID_ADMIN_PHONE', message: error.message }); }
});

app.get('/api/admin/sms/status', requireAdmin, (req, res) => {
  res.json({
    configured: Boolean(process.env.TEXTSMS_API_KEY && process.env.TEXTSMS_PARTNER_ID && process.env.TEXTSMS_SENDER_ID),
    provider: 'TextSMS',
    senderId: process.env.TEXTSMS_SENDER_ID || null,
    partnerId: process.env.TEXTSMS_PARTNER_ID || null,
    reachability: 'unknown'
  });
});

app.get('/api/admin/outdoor-wifi/message-templates', requireAdmin, async (req, res) => {
  const types = Object.keys(OUTDOOR_TEMPLATES);
  const result = await db.query('select message_type, template, updated_at, updated_by from sms_message_templates where message_type = any($1) order by message_type', [types]);
  return res.json({ templates: types.map(message_type => ({ message_type, template: result.rows.find(row => row.message_type === message_type)?.template || OUTDOOR_TEMPLATES[message_type] })) });
});
app.put('/api/admin/outdoor-wifi/message-templates/:messageType', requireAdmin, async (req, res) => {
  const type = req.params.messageType;
  if (!OUTDOOR_TEMPLATES[type]) return res.status(400).json({ error: 'UNSUPPORTED_MESSAGE_TYPE' });
  const template = String(req.body?.template || '').trim();
  if (!template || template.length > 480 || [...template.matchAll(/\\{\\{([^}]+)\\}\\}/g)].some(match => !['package','mac','expiry','customer','phone'].includes(match[1]))) return res.status(400).json({ error: 'INVALID_OUTDOOR_TEMPLATE', message: 'Use only {{package}}, {{mac}}, {{expiry}}, {{customer}}, and {{phone}}; maximum 480 characters.' });
  const result = await db.query(`insert into sms_message_templates (message_type, template, updated_by) values ($1,$2,'admin') on conflict (message_type) do update set template=excluded.template, updated_at=now(), updated_by='admin' returning *`, [type, template]);
  return res.json({ template: result.rows[0] });
});

app.get('/api/admin/sms/templates', requireAdmin, async (req, res) => {
  try {
    const result = await db.query('select message_type, template, updated_at, updated_by from sms_message_templates order by message_type');
    return res.json({ templates: result.rows, supportedPlaceholders: ['{{voucher}}', '{{package}}', '{{duration}}', '{{portal_url}}', '{{support}}'], requiredPlaceholders: ['{{voucher}}'] });
  } catch (err) {
    return res.status(500).json({ error: 'SMS_TEMPLATES_FAILED', message: 'Unable to load message templates.' });
  }
});

app.put('/api/admin/sms/templates/:messageType', requireAdmin, async (req, res) => {
  if (![EVENT_TYPE, FREE_ACCESS_EVENT_TYPE].includes(req.params.messageType)) return res.status(400).json({ error: 'UNSUPPORTED_MESSAGE_TYPE', message: 'Unsupported message type.' });
  try {
    const template = req.params.messageType === FREE_ACCESS_EVENT_TYPE ? validateFreeAccessTemplate(req.body?.template) : validateTemplate(req.body?.template);
    const result = await db.query(`insert into sms_message_templates (message_type, template, updated_by) values ($1, $2, 'admin') on conflict (message_type) do update set template = excluded.template, updated_at = now(), updated_by = excluded.updated_by returning message_type, template, updated_at, updated_by`, [req.params.messageType, template]);
    return res.json({ template: result.rows[0] });
  } catch (err) {
    return res.status(400).json({ error: 'INVALID_SMS_TEMPLATE', message: err.message });
  }
});

app.post('/api/admin/sms/templates/:messageType/reset', requireAdmin, async (req, res) => {
  if (![EVENT_TYPE, FREE_ACCESS_EVENT_TYPE].includes(req.params.messageType)) return res.status(400).json({ error: 'UNSUPPORTED_MESSAGE_TYPE', message: 'Unsupported message type.' });
  try {
    const templateType = req.params.messageType;
    const templateDefault = templateType === FREE_ACCESS_EVENT_TYPE ? FREE_ACCESS_DEFAULT_TEMPLATE : DEFAULT_TEMPLATE;
    const result = await db.query(`insert into sms_message_templates (message_type, template, updated_by) values ($1, $2, 'system') on conflict (message_type) do update set template = excluded.template, updated_at = now(), updated_by = excluded.updated_by returning message_type, template, updated_at, updated_by`, [templateType, templateDefault]);
    return res.json({ template: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'SMS_TEMPLATE_RESET_FAILED', message: 'Unable to reset message template.' });
  }
});

app.get('/api/admin/sms/history', requireAdmin, async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 100);
  try {
    const result = await db.query(`select id, recipient, message_type, message, status, provider_message_id, attempt_count, next_attempt_at, last_error, created_at from sms_messages order by created_at desc limit $1`, [limit]);
    return res.json({ messages: result.rows.map(row => ({ id: row.id, recipient: `${row.recipient.slice(0, 6)}***${row.recipient.slice(-3)}`, messageType: row.message_type, message: row.message, status: row.status, providerMessageId: row.provider_message_id, attemptCount: row.attempt_count, nextAttemptAt: row.next_attempt_at, lastError: row.last_error, createdAt: row.created_at })) });
  } catch (err) {
    console.error('GET /api/admin/sms/history error:', err.message);
    return res.status(500).json({ error: 'SMS_HISTORY_FAILED', message: 'Unable to load SMS activity.' });
  }
});

app.get('/api/admin/sms/attention', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(`select sms.id, sms.recipient, sms.message, sms.message_type, sms.status, sms.provider, sms.provider_message_id, sms.error_message, sms.provider_response_code, sms.provider_response_description, sms.order_reference, sms.voucher_code, sms.package_name, sms.package_price, sms.attempt_number, sms.parent_sms_id, sms.created_at, sms.failed_at
      from sms_messages sms
      where sms.status = 'FAILED' and sms.parent_sms_id is null and sms.message_type in ('PURCHASE_CONFIRMATION', 'FREE_ACCESS', 'MANUAL')
        and not exists (select 1 from sms_messages retry where retry.parent_sms_id = sms.id and retry.status = 'SENT')
      order by sms.failed_at desc nulls last, sms.created_at desc limit 100`);
    return res.json({ ok: true, messages: result.rows, count: result.rowCount });
  } catch (error) {
    console.error('GET /api/admin/sms/attention error:', error.message);
    return res.status(500).json({ ok: false, error: 'SMS_ATTENTION_FAILED', message: 'Unable to load failed SMS.' });
  }
});

app.post('/api/admin/sms/:id/retry', requireAdmin, async (req, res) => {
  if (!/^\\d+$/.test(req.params.id)) return res.status(400).json({ error: 'INVALID_SMS_ID' });
  const original = await db.query(`select * from sms_messages where id = $1 and status = 'FAILED'`, [req.params.id]);
  if (!original.rowCount) return res.status(404).json({ error: 'SMS_NOT_RETRYABLE', message: 'Only failed SMS records can be retried.' });
  const row = original.rows[0];
  const attempt = await db.query(`select coalesce(max(attempt_number), 1) + 1 as next_attempt from sms_messages where id = $1 or parent_sms_id = $1`, [row.parent_sms_id || row.id]);
  const parentId = row.parent_sms_id || row.id;
  const created = await db.query(`insert into sms_messages (recipient, message, message_type, status, provider, network, created_by, source, order_reference, voucher_code, package_name, package_price, parent_sms_id, attempt_number) values ($1, $2, $3, 'SENDING', 'TextSMS', $4, 'admin', 'admin-sms-retry', $5, $6, $7, $8, $9, $10) returning id`, [row.recipient, row.message, row.message_type, row.network || 'Safaricom', row.order_reference, row.voucher_code, row.package_name, row.package_price, parentId, attempt.rows[0].next_attempt]);
  const retryId = created.rows[0].id;
  try {
    const sent = await sendTextSms({ phone: row.recipient, message: row.message });
    const providerResponse = sent.providerResponse?.responses?.[0] || sent.providerResponse || {};
    await db.query(`update sms_messages set status = 'SENT', provider_message_id = $1, provider_response_code = $2, provider_response_description = $3, sent_at = now() where id = $4`, [sent.messageId, providerResponse['response-code'] || providerResponse.response_code || null, providerResponse['response-description'] || providerResponse.response_description || null, retryId]);
    return res.json({ success: true, status: 'SENT', messageId: sent.messageId, retryId });
  } catch (error) {
    await db.query(`update sms_messages set status = 'FAILED', error_message = $1, failed_at = now() where id = $2`, [error.message, retryId]);
    return res.status(502).json({ success: false, status: 'FAILED', retryId, message: error.message });
  }
});

app.post('/api/admin/sms/send', requireAdmin, async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message || Object.keys(req.body || {}).some(key => !['phone', 'message'].includes(key))) return res.status(400).json({ error: 'INVALID_SMS_REQUEST', message: 'Provide only phone and message.' });
  let result;
  try {
    result = await sendTextSms({ phone, message });
  } catch (err) {
    console.error('POST /api/admin/sms/send provider failed:', err.message);
    console.error('[SMS PROVIDER CONFIG]', JSON.stringify({ endpoint: process.env.TEXTSMS_ENDPOINT || 'default', senderId: process.env.TEXTSMS_SENDER_ID || null, partnerIdPresent: Boolean(process.env.TEXTSMS_PARTNER_ID), apiKeyPresent: Boolean(process.env.TEXTSMS_API_KEY) }));
    await db.query(`insert into sms_messages (recipient, message, message_type, status, provider, network, error_message, created_by, source) values ($1, $2, 'MANUAL', 'FAILED', 'TextSMS', 'Safaricom', $3, 'admin', 'admin-sms-center')`, [String(phone), String(message).trim(), err.message]).catch((historyError) => console.error('POST /api/admin/sms/send failure history failed:', historyError.message));
    return res.status(502).json({ ok: false, error: 'SMS_DELIVERY_FAILED', message: err.message, provider: 'TextSMS', hint: 'The backend reached TextSMS but the provider rejected or could not process this message.' });
  }

  let historyRecorded = true;
  let historyWarning = null;
  try {
    await db.query(`insert into sms_messages (recipient, message, message_type, status, provider, provider_message_id, network, created_by, source, sent_at) values ($1, $2, 'MANUAL', 'SENT', 'TextSMS', $3, 'Safaricom', 'admin', 'admin-sms-center', now())`, [result.phone, String(message).trim(), result.messageId]);
  } catch (err) {
    historyRecorded = false;
    historyWarning = 'SMS was accepted by the provider, but delivery history could not be saved.';
    console.error('POST /api/admin/sms/send history failed:', err.message);
  }

  return res.json({
    success: true,
    status: 'SENT',
    phone: result.phone,
    messageId: result.messageId,
    historyRecorded,
    historyWarning
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(rootDir, 'admin.html'));
});

// Lightweight probe the admin page uses to validate the token before loading.
app.get('/api/admin/session', requireAdmin, (req, res) => {
  return res.json({ ok: true });
});

// Inventory summary grouped by package, plus the package list for the form.
app.get('/api/admin/summary', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      select
        p.id,
        p.name,
        p.price,
        count(v.id) filter (where v.status = 'AVAILABLE')       as available,
        count(v.id) filter (where v.status = 'ASSIGNED')        as assigned,
        count(v.id) filter (where v.status = 'USED')            as used,
        count(v.id) filter (where v.status = 'BLOCKED')         as blocked,
        count(v.id)                                             as total
      from packages p
      left join vouchers v on v.package_id = p.id
      group by p.id, p.name, p.price
      order by p.price desc
    `);

    return res.json({
      packages: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        price: Number(row.price),
        available: Number(row.available),
        assigned: Number(row.assigned),
        used: Number(row.used),
        blocked: Number(row.blocked),
        total: Number(row.total)
      })),
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('GET /api/admin/summary error:', err.message);
    return res.status(500).json({ error: 'SUMMARY_FAILED', message: 'Unable to load voucher inventory.' });
  }
});

// Recent vouchers, optionally filtered by package and/or status.
app.get('/api/admin/vouchers', requireAdmin, async (req, res) => {
  const packageId = (req.query.packageId || '').toString().trim();
  const status = (req.query.status || '').toString().trim().toUpperCase();
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

  const conditions = [];
  const params = [];
  let i = 1;

  if (packageId) {
    conditions.push(`v.package_id = $${i++}`);
    params.push(packageId);
  }
  if (status) {
    conditions.push(`v.status = $${i++}`);
    params.push(status);
  }

  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  params.push(limit);

  try {
    const result = await db.query(
      `select
         v.id,
         v.code,
         v.package_id,
         p.name as package_name,
         v.status,
         v.order_id,
         o.reference as order_reference,
         v.created_at,
         v.assigned_at,
         v.used_at
       from vouchers v
       join packages p on p.id = v.package_id
       left join orders o on o.id = v.order_id
       ${where}
       order by v.created_at desc
       limit $${i}`,
      params
    );

    return res.json({ vouchers: result.rows });
  } catch (err) {
    console.error('GET /api/admin/vouchers error:', err.message);
    return res.status(500).json({ error: 'VOUCHER_LIST_FAILED', message: 'Unable to load vouchers.' });
  }
});

// Bulk import voucher codes for a specific package.
// Codes exported from MyPublicWiFi are pasted or uploaded, deduped, and inserted.
app.post('/api/admin/vouchers', requireAdmin, async (req, res) => {
  const packageId = (req.body.packageId || req.body.package_id || '').toString().trim();
  const rawCodes = Array.isArray(req.body.codes) ? req.body.codes : [];

  if (!packageId) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'packageId is required.' });
  }

  // Normalize: trim, drop empties, uppercase, and dedupe within the request.
  const seen = new Set();
  const codes = [];
  for (const entry of rawCodes) {
    const code = String(entry || '').trim();
    if (!code) continue;
    const key = code.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    codes.push(code);
  }

  if (codes.length === 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'At least one voucher code is required.' });
  }

  if (codes.length > 5000) {
    return res.status(400).json({ error: 'TOO_MANY_CODES', message: 'Import at most 5000 codes per request.' });
  }

  try {
    const pkg = await db.query('select id, name from packages where id = $1', [packageId]);
    if (pkg.rowCount === 0) {
      return res.status(404).json({ error: 'PACKAGE_NOT_FOUND', message: 'Unknown package selected.' });
    }

    const valuePlaceholders = [];
    const values = [];
    let i = 1;
    for (const code of codes) {
      valuePlaceholders.push(`($${i++}, $${i++}, $${i++}, 'AVAILABLE', now())`);
      values.push(crypto.randomUUID(), code, packageId);
    }

    // Codes already present (any package) are skipped via the unique(code) constraint.
    const insertResult = await db.query(
      `insert into vouchers (id, code, package_id, status, created_at)
       values ${valuePlaceholders.join(', ')}
       on conflict (code) do nothing
       returning code`,
      values
    );

    const inserted = insertResult.rowCount;
    const skipped = codes.length - inserted;

    return res.status(201).json({
      success: true,
      packageId,
      packageName: pkg.rows[0].name,
      received: codes.length,
      inserted,
      skipped,
      message: `${inserted} voucher(s) added to ${pkg.rows[0].name}. ${skipped} duplicate(s) skipped.`
    });
  } catch (err) {
    console.error('POST /api/admin/vouchers error:', err.message);
    return res.status(500).json({ error: 'VOUCHER_IMPORT_FAILED', message: 'Unable to import vouchers.' });
  }
});

// Remove a voucher that has not yet been assigned (for correcting bad imports).
app.delete('/api/admin/vouchers/:id', requireAdmin, async (req, res) => {
  const id = req.params.id.trim();

  try {
    const result = await db.query(
      `delete from vouchers
       where id::text = $1 and status = 'AVAILABLE'
       returning id`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        error: 'DELETE_BLOCKED',
        message: 'Only AVAILABLE (unassigned) vouchers can be deleted.'
      });
    }

    return res.json({ success: true, deleted: id });
  } catch (err) {
    console.error('DELETE /api/admin/vouchers/:id error:', err.message);
    return res.status(500).json({ error: 'VOUCHER_DELETE_FAILED', message: 'Unable to delete voucher.' });
  }
});

app.get('/api/admin/expiry/summary', requireAdmin, async (req, res) => {
  try {
    const [summary, records, rules, currentVouchers] = await Promise.all([
      db.query(`select count(*) filter (where status in ('ACTIVE','EXPIRING_SOON'))::int as active, count(*) filter (where expected_expires_at::date = current_date)::int as expiring_today, count(*) filter (where expected_expires_at between now() and now() + interval '1 hour')::int as expiring_hour, count(*) filter (where status = 'EXPIRED')::int as expired from expiry_records`),
      db.query(`select r.*, (select min(e.scheduled_for) from expiry_events e where e.expiry_record_id=r.id and e.status='SCHEDULED') as next_reminder, (select max(e.sent_at) from expiry_events e where e.expiry_record_id=r.id and e.status='SENT') as last_reminder from expiry_records r order by r.expected_expires_at asc limit 200`),
      db.query('select * from expiry_rules order by sort_order, id'),
      db.query(`select r.id, r.order_id, r.order_reference, r.voucher_code, r.customer_phone, r.package_name, r.package_price, r.purchased_at, r.activation_reference_at, r.expected_expires_at, r.status
        from expiry_records r
        join orders o on o.id = r.order_id
        where o.status = 'VOUCHER_ASSIGNED'
          and r.status <> 'CANCELLED'
          and r.expected_expires_at > now()
        order by r.expected_expires_at asc`)
    ]);
  const templates = await db.query('select rule_id, event_type, template_text, enabled, updated_at from expiry_message_templates order by rule_id nulls last, updated_at desc');
  return res.json({ summary: summary.rows[0], records: records.rows, currentVouchers: currentVouchers.rows, rules: rules.rows, templates: templates.rows, timeZone: 'Africa/Nairobi' });
  } catch (error) { return res.status(500).json({ error: 'EXPIRY_SUMMARY_FAILED', message: error.message }); }
});

const EXPIRY_TEMPLATE_TYPES = new Set(['EXPIRY_REMINDER','EXPIRY_FINAL_REMINDER','EXPIRY_EXPIRED']);
const EXPIRY_TEMPLATE_KEYS = new Set(['voucher','package','expiry_time','remaining_time','portal_url','support']);
app.patch('/api/admin/expiry/templates/:ruleId', requireAdmin, async (req, res) => {
  const ruleId = Number(req.params.ruleId);
  const template = String(req.body.template_text || '').trim();
  if (!Number.isSafeInteger(ruleId) || ruleId < 1) return res.status(400).json({ error: 'INVALID_RULE_ID' });
  if (!template) return res.status(400).json({ error: 'EMPTY_TEMPLATE', message: 'Message cannot be empty.' });
  if (template.length > 480) return res.status(400).json({ error: 'TEMPLATE_TOO_LONG', message: 'Message cannot exceed 480 characters.' });
  const placeholders = template.match(/\{\{.*?\}\}/g) || [];
  const malformed = template.replace(/\{\{.*?\}\}/g, '').match(/\{\{|\}\}/g);
  const unsupported = [...new Set(placeholders.map((item) => item.slice(2, -2).trim()).filter((key) => !EXPIRY_TEMPLATE_KEYS.has(key)))];
  if (malformed || unsupported.length) return res.status(400).json({ error: 'INVALID_PLACEHOLDER', message: unsupported.length ? `Unsupported placeholder: {{${unsupported[0]}}}` : 'Malformed placeholder syntax.' });
  try {
    const client = await db.connect(); await client.query('begin');
  const rule = await client.query('select id, event_type, offset_minutes from expiry_rules where id=$1 for update', [ruleId]);
  if (!rule.rowCount) { await client.query('rollback'); client.release(); return res.status(404).json({ error: 'RULE_NOT_FOUND' }); }
  const { event_type: eventType, offset_minutes: offsetMinutes } = rule.rows[0];
  const old = await client.query('select template_text from expiry_message_templates where rule_id=$1 for update', [ruleId]);
  const updated = await client.query(`update expiry_message_templates set template_text=$2, event_type=$3, updated_by='admin', updated_at=now() where rule_id=$1 returning rule_id, event_type, template_text, updated_at`, [ruleId, template, eventType]);
  const saved = updated.rows[0] || (await client.query(`insert into expiry_message_templates (rule_id, event_type, template_text, updated_by) values ($1,$2,$3,'admin') returning rule_id, event_type, template_text, updated_at`, [ruleId, eventType, template])).rows[0];
  await client.query(`insert into expiry_audit_log (action, actor, details) values ('EXPIRY_TEMPLATE_CHANGED','admin',$1)`, [JSON.stringify({ ruleId, eventType, offsetMinutes, oldTemplate: old.rows[0]?.template_text || null, newTemplate: template })]);
  await client.query('commit'); client.release(); return res.json({ ...saved, message: 'Expiry message saved.' });
  } catch (error) { return res.status(500).json({ error: 'EXPIRY_TEMPLATE_SAVE_FAILED', message: 'Could not save expiry message.' }); }
});

app.patch('/api/admin/expiry/rules/:id', requireAdmin, async (req, res) => {
  const enabled = req.body.enabled === true;
  const hasOffset = Object.prototype.hasOwnProperty.call(req.body, 'offset_minutes');
  const offset = hasOffset ? Number(req.body.offset_minutes) : null;
  if (hasOffset && (!Number.isInteger(offset) || offset < 0)) return res.status(400).json({ error: 'INVALID_OFFSET' });

  const client = await db.connect();
  try {
    await client.query('begin');
    const current = await client.query('select id, name, event_type, offset_minutes, enabled from expiry_rules where id=$1 for update', [req.params.id]);
    if (!current.rowCount) { await client.query('rollback'); return res.status(404).json({ error: 'RULE_NOT_FOUND' }); }
    const previous = current.rows[0];
    const result = await client.query(`update expiry_rules set enabled=$1, offset_minutes=coalesce($2, offset_minutes), updated_at=now() where id=$3 returning *`, [enabled, offset, req.params.id]);
    if (!enabled) {
      await client.query(`update expiry_events set status='CANCELLED', cancelled_at=now(), updated_at=now() where event_type=$1 and reminder_offset_minutes=$2 and status='SCHEDULED'`, [previous.event_type, previous.offset_minutes]);
    }
    await client.query(`insert into expiry_audit_log (action, actor, details) values ('EXPIRY_SCHEDULE_CHANGED','admin',$1)`, [JSON.stringify({ ruleId: req.params.id, rule: previous.name, oldEnabled: previous.enabled, newEnabled: enabled, offset: offset ?? previous.offset_minutes })]);
    await client.query('commit');
    return res.json({ rule: result.rows[0] });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    console.error('PATCH /api/admin/expiry/rules/:id error:', error.message);
    return res.status(500).json({ error: 'RULE_UPDATE_FAILED', message: 'Unable to update reminder rule.' });
  } finally { client.release(); }
});

app.post('/api/admin/expiry/:id/correct', requireAdmin, async (req, res) => {
  const expiresAt = new Date(req.body.expected_expires_at);
  if (Number.isNaN(expiresAt.getTime())) return res.status(400).json({ error: 'INVALID_EXPIRY_TIME' });
  const client = await db.connect();
  try {
    await client.query('begin');
    const current = await client.query('select * from expiry_records where id=$1 for update', [req.params.id]);
    if (!current.rowCount) throw new Error('Expiry record not found');
    const oldExpiry = current.rows[0].expected_expires_at;
    await client.query(`update expiry_records set expected_expires_at=$1, updated_at=now(), status=case when $1 <= now() then 'EXPIRED' when $1 <= now()+interval '1 hour' then 'EXPIRING_SOON' else 'ACTIVE' end where id=$2`, [expiresAt, req.params.id]);
    await client.query(`update expiry_events set scheduled_for=$1 - make_interval(mins => reminder_offset_minutes), updated_at=now() where expiry_record_id=$2 and status='SCHEDULED' and custom_scheduled_for is null`, [expiresAt, req.params.id]);
    await client.query(`insert into expiry_audit_log (expiry_record_id, action, actor, details) values ($1,'EXPIRY_CORRECTED','admin',$2)`, [req.params.id, JSON.stringify({ oldExpiry, newExpiry: expiresAt })]);
    await client.query('commit');
    return res.json({ success: true, expected_expires_at: expiresAt });
  } catch (error) { await client.query('rollback').catch(() => {}); return res.status(400).json({ error: 'EXPIRY_CORRECTION_FAILED', message: error.message }); } finally { client.release(); }
});

app.post('/api/admin/expiry/:id/cancel', requireAdmin, async (req, res) => {
  await db.query(`update expiry_records set status='CANCELLED', alerts_cancelled_at=now(), updated_at=now() where id=$1`, [req.params.id]);
  await db.query(`update expiry_events set status='CANCELLED', cancelled_at=now(), updated_at=now() where expiry_record_id=$1 and status='SCHEDULED'`, [req.params.id]);
  await db.query(`insert into expiry_audit_log (expiry_record_id, action, actor) values ($1,'EXPIRY_ALERT_CANCELLED','admin')`, [req.params.id]);
  return res.json({ success: true });
});

app.post('/api/admin/expiry/:id/send', requireAdmin, async (req, res) => {
  const recordResult = await db.query('select * from expiry_records where id=$1', [req.params.id]);
  if (!recordResult.rowCount) return res.status(404).json({ error: 'EXPIRY_NOT_FOUND' });
  const record = recordResult.rows[0];
  const eventType = req.body.expired === true ? 'EXPIRY_MANUAL_EXPIRED' : 'EXPIRY_MANUAL_REMINDER';
  const message = req.body.message || (eventType === 'EXPIRY_MANUAL_EXPIRED' ? `SUPA LAN: Your ${record.package_name} package has expired. Purchase another package to continue using SUPA LAN.` : `SUPA LAN: Your ${record.package_name} package is still active and expires at ${new Date(record.expected_expires_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}. Renew your package to continue browsing.`);
  try {
    const sent = await sendTextSms({ phone: record.customer_phone, message });
    await db.query(`insert into sms_messages (recipient,message,message_type,status,provider,provider_message_id,event_key,network,created_by,source,order_reference,voucher_code,package_name,package_price,sent_at) values ($1,$2,$3,'SENT','TextSMS',$4,$5,'Safaricom','admin','expiry-manual',$6,$7,$8,$9,now())`, [record.customer_phone, message, eventType, sent.messageId, `${eventType}:${record.order_reference}:${crypto.randomUUID()}`, record.order_reference, record.voucher_code, record.package_name, record.package_price]);
    await db.query(`insert into expiry_audit_log (expiry_record_id,action,actor,details) values ($1,'EXPIRY_MANUAL_SENT','admin',$2)`, [record.id, JSON.stringify({ eventType, message })]);
    return res.json({ success: true, status: 'SENT', messageId: sent.messageId });
  } catch (error) { return res.status(502).json({ error: 'EXPIRY_MANUAL_SEND_FAILED', message: error.message }); }
});

async function startServer() {
  await ensureExpirySchema();
  startFreeAccessSmsWorker(db);
  startExpiryScheduler(db);
  logOutdoorWifiSmsConfig(db).catch((error) => console.error('[OUTDOOR_WIFI_SMS_CONFIG]', error.message));
  setInterval(() => processOutdoorWifiExpiry(db).catch((error) => console.error('[OUTDOOR_WIFI_EXPIRY]', error.message)), 60 * 1000);

  app.listen(PORT, () => {
    console.log(`ANONYMIKECONNECT Phase 1 test backend running on http://localhost:${PORT}`);
    console.log(`TEST_MODE=${testMode}`);
  });
}

startServer().catch((error) => {
  console.error('[SERVER STARTUP]', error.message);
  process.exitCode = 1;
});
