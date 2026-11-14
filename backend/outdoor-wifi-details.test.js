const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPortalData } = require('./outdoor-wifi-portal');
const { normalizeKenyanPhone } = require('./textsms');

const NOW = Date.parse('2026-11-14T12:00:00.000Z');

async function loadForStatus(status) {
  const client = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    customer_name: 'Subscriber',
    phone: '254712345678',
    package_name: 'Weekly Unlimited',
    package_price: 150,
    package_id: 'week',
    activation_at: new Date(NOW - 60_000).toISOString(),
    expected_expiry_at: new Date(NOW + 86_400_000).toISOString(),
    status,
    blacklist_enabled: status === 'BLACKLISTED',
    created_at: new Date(NOW - 60_000).toISOString(),
    order_id: null,
    linked_paid_at: null,
    previous_paid_at: new Date(NOW - 60_000).toISOString(),
    linked_order_status: null,
    linked_payment_provider: null,
    linked_checkout_id: null,
    linked_amount: null,
    linked_package_name: null,
  };
  const db = {
    async query(sql) {
      if (sql.includes('left join lateral')) return { rowCount: 1, rows: [client] };
      if (sql.includes('from packages p')) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  return loadPortalData({
    db,
    clientId: client.id,
    normalizePhone: normalizeKenyanPhone,
    getStatus: (row, now) => status === 'BLACKLISTED'
      ? 'BLACKLISTED'
      : status === 'ACTION_REQUIRED' || new Date(row.expected_expiry_at) <= now ? 'ACTION_REQUIRED' : 'ACTIVE',
    timestamp: NOW,
  });
}

test('active subscribers receive network credentials only after portal verification', async (t) => {
  const previous = {
    ssid: process.env.OUTDOOR_WIFI_SSID,
    password: process.env.OUTDOOR_WIFI_PASSWORD,
    authentication: process.env.OUTDOOR_WIFI_AUTHENTICATION,
  };
  t.after(() => {
    if (previous.ssid === undefined) delete process.env.OUTDOOR_WIFI_SSID;
    else process.env.OUTDOOR_WIFI_SSID = previous.ssid;
    if (previous.password === undefined) delete process.env.OUTDOOR_WIFI_PASSWORD;
    else process.env.OUTDOOR_WIFI_PASSWORD = previous.password;
    if (previous.authentication === undefined) delete process.env.OUTDOOR_WIFI_AUTHENTICATION;
    else process.env.OUTDOOR_WIFI_AUTHENTICATION = previous.authentication;
  });

  process.env.OUTDOOR_WIFI_SSID = 'SYNTHNET-OUTDOOR';
  process.env.OUTDOOR_WIFI_PASSWORD = 'test-only-wifi-key';
  process.env.OUTDOOR_WIFI_AUTHENTICATION = 'WPA2/WPA3-PSK';
  const data = await loadForStatus('ACTIVE');
  assert.deepEqual(data.wifi, {
    available: true,
    ssid: 'SYNTHNET-OUTDOOR',
    authentication: 'WPA2/WPA3-PSK',
    password: 'test-only-wifi-key',
    message: '',
  });
});

test('expired or blacklisted subscribers do not receive the Wi-Fi password', async () => {
  const previous = {
    ssid: process.env.OUTDOOR_WIFI_SSID,
    password: process.env.OUTDOOR_WIFI_PASSWORD,
  };
  process.env.OUTDOOR_WIFI_SSID = 'SYNTHNET-OUTDOOR';
  process.env.OUTDOOR_WIFI_PASSWORD = 'test-only-wifi-key';
  try {
    const expired = await loadForStatus('ACTION_REQUIRED');
    const blacklisted = await loadForStatus('BLACKLISTED');
    assert.equal(expired.wifi.available, false);
    assert.equal(expired.wifi.password, '');
    assert.equal(blacklisted.wifi.available, false);
    assert.equal(blacklisted.wifi.password, '');
  } finally {
    if (previous.ssid === undefined) delete process.env.OUTDOOR_WIFI_SSID;
    else process.env.OUTDOOR_WIFI_SSID = previous.ssid;
    if (previous.password === undefined) delete process.env.OUTDOOR_WIFI_PASSWORD;
    else process.env.OUTDOOR_WIFI_PASSWORD = previous.password;
  }
});
