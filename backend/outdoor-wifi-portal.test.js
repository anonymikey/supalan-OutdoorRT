const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createOutdoorPortalRouter } = require('./outdoor-wifi-portal');
const { deriveStatus } = require('./outdoor-wifi');

const NOW = Date.parse('2026-11-13T12:00:00.000Z');

function createTestServer({ subscriber = true } = {}) {
  const sentMessages = [];
  const db = {
    async query(sql) {
      if (sql.includes('select 1') && sql.includes('outdoor_wifi_clients')) {
        return { rowCount: subscriber ? 1 : 0, rows: subscriber ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('select c.id') && sql.includes('from outdoor_wifi_clients c') && !sql.includes('left join orders')) {
        return { rowCount: subscriber ? 1 : 0, rows: subscriber ? [{ id: '123e4567-e89b-12d3-a456-426614174000' }] : [] };
      }
      if (sql.includes('from outdoor_wifi_clients c') && sql.includes('left join orders')) {
        if (!subscriber) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [{
            id: '123e4567-e89b-12d3-a456-426614174000',
            customer_name: 'Maya Njeri',
            phone: '0712345678',
            package_name: 'Weekly Unlimited',
            package_price: 150,
            package_id: 'week',
            activation_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
            expected_expiry_at: new Date(NOW + 6 * 60 * 60 * 1000).toISOString(),
            status: 'ACTIVE',
            blacklist_enabled: false,
            created_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
            order_id: '123e4567-e89b-12d3-a456-426614174001',
            linked_paid_at: new Date(NOW - 65 * 60 * 1000).toISOString(),
            previous_paid_at: null,
            linked_order_status: 'PAID',
            linked_payment_provider: 'PALPLUSS',
            linked_checkout_id: null,
            linked_amount: 150,
            linked_package_name: 'Weekly Unlimited',
            mac_address: 'AA:BB:CC:DD:EE:FF',
            voucher_code: 'SECRET-CODE',
          }],
        };
      }
      if (sql.includes('from packages p')) {
        return { rowCount: 1, rows: [{ id: 'week', name: 'Weekly Unlimited', price: 150, duration: '7 days', bandwidth: 'unlimited', data: 'Unlimited', available: true }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/outdoor-wifi/portal', createOutdoorPortalRouter({
    db,
    now: () => NOW,
    createCode: () => '036914',
    deriveStatus,
    sendSms: async (message) => sentMessages.push(message),
  }));
  const server = app.listen(0);
  return {
    sentMessages,
    url: new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('subscribers must verify an SMS code before viewing their own package', async (t) => {
  const runtime = createTestServer();
  t.after(runtime.close);
  const base = await runtime.url;

  const requested = await fetch(`${base}/api/outdoor-wifi/portal/request-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '0712345678' }),
  });
  assert.equal(requested.status, 202);
  assert.equal(runtime.sentMessages.length, 1);
  assert.match(runtime.sentMessages[0].message, /036914/);
  assert.equal(runtime.sentMessages[0].phone, '254712345678');

  const rejected = await fetch(`${base}/api/outdoor-wifi/portal/verify-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '0712345678', code: '000000' }),
  });
  assert.equal(rejected.status, 400);

  const verified = await fetch(`${base}/api/outdoor-wifi/portal/verify-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '0712345678', code: '036914' }),
  });
  assert.equal(verified.status, 200);
  const body = await verified.json();
  assert.equal(body.subscriber.name, 'Maya Njeri');
  assert.equal(body.subscriber.packageName, 'Weekly Unlimited');
  assert.equal(body.subscriber.status, 'ACTIVE');
  assert.equal(body.subscriber.purchaseTimeSource, 'payment');
  assert.equal(body.subscriber.phone, '+254712••••78');
  assert.equal(body.packages.length, 1);
  assert.equal(typeof body.sessionToken, 'string');
  assert.equal(JSON.stringify(body).includes('SECRET-CODE'), false);
  assert.equal(JSON.stringify(body).includes('AA:BB:CC:DD:EE:FF'), false);

  const unauthorizedRenewal = await fetch(`${base}/api/outdoor-wifi/portal/renewals/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packageId: 'week' }),
  });
  assert.equal(unauthorizedRenewal.status, 401);

  const replay = await fetch(`${base}/api/outdoor-wifi/portal/verify-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '0712345678', code: '036914' }),
  });
  assert.equal(replay.status, 400);
});

test('unknown numbers get a generic response and no SMS is sent', async (t) => {
  const runtime = createTestServer({ subscriber: false });
  t.after(runtime.close);
  const response = await fetch(`${await runtime.url}/api/outdoor-wifi/portal/request-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '0712345678' }),
  });
  assert.equal(response.status, 202);
  assert.equal(runtime.sentMessages.length, 0);
  assert.match((await response.json()).message, /If an Outdoor Wi-Fi subscription matches/);
});
