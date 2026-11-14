const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createOutdoorPortalRouter } = require('./outdoor-wifi-portal');
const { deriveStatus } = require('./outdoor-wifi');

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const CLIENT_ID = '123e4567-e89b-12d3-a456-426614174000';

function createRuntime() {
  const subscriber = {
    id: CLIENT_ID,
    customer_name: 'Maya Njeri',
    phone: '254712345678',
    package_id: 'old-plan',
    package_name: 'Previous plan',
    package_price: 100,
    activation_at: new Date(NOW - 7 * 86400000).toISOString(),
    expected_expiry_at: new Date(NOW + 86400000).toISOString(),
    status: 'ACTIVE',
    blacklist_enabled: false,
    created_at: new Date(NOW - 7 * 86400000).toISOString(),
    order_id: null,
    order_reference: 'previous-ref',
  };
  const plans = [{ id: 'week', name: 'Weekly Unlimited', price: 150, duration: '7 days', bandwidth: 'unlimited', data: 'Unlimited', available: true }];
  const orders = new Map();
  let providerStatus = 'pending';
  let startedPayment = null;

  function result(rows = []) {
    return { rows, rowCount: rows.length };
  }

  function execute(sql, params = []) {
    const query = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(query)) return result();
    if (query.startsWith('select 1') && query.includes('outdoor_wifi_clients')) return result([{ one: 1 }]);
    if (query.startsWith('select c.id') && query.includes('outdoor_wifi_clients c') && !query.includes('left join')) {
      return result([{ id: CLIENT_ID }]);
    }
    if (query.includes('select c.id, c.phone, c.order_id') && query.includes('left join orders linked_order')) {
      const linked = orders.get(subscriber.order_id) || {};
      return result([{
        id: subscriber.id,
        phone: subscriber.phone,
        order_id: subscriber.order_id,
        linked_order_status: linked.status || null,
        linked_payment_provider: linked.payment_provider || null,
        provider_checkout_id: linked.provider_checkout_id || null,
        linked_amount: linked.amount || null,
        linked_package_name: linked.packageName || null,
      }]);
    }
    if (query.includes('left join lateral') && query.includes('from outdoor_wifi_clients c')) {
      const linked = orders.get(subscriber.order_id) || {};
      const priorPaid = [...orders.values()].filter((order) => order.package_id === subscriber.package_id && order.paid_at).sort((a, b) => b.paid_at - a.paid_at)[0];
      return result([{
        ...subscriber,
        linked_paid_at: linked.paid_at || null,
        previous_paid_at: priorPaid ? priorPaid.paid_at : new Date(NOW - 7 * 86400000).toISOString(),
        linked_order_status: linked.status || null,
        linked_payment_provider: linked.payment_provider || null,
        linked_checkout_id: linked.provider_checkout_id || null,
        linked_amount: linked.amount || null,
        linked_package_name: linked.packageName || null,
      }]);
    }
    if (query.includes('from packages p')) return result(plans);
    if (query.includes('join orders o') && query.includes("o.payment_provider = 'courtneytech'")) {
      const order = orders.get(params[1]);
      return order && subscriber.order_id === order.id ? result([{
        ...order,
        package_id: order.package_id,
        package_name: order.packageName,
        duration: order.duration,
        blacklist_enabled: subscriber.blacklist_enabled,
      }]) : result();
    }
    if (query.includes('select o.status, c.blacklist_enabled')) {
      const order = orders.get(params[0]);
      return order && subscriber.order_id === order.id ? result([{ status: order.status, blacklist_enabled: subscriber.blacklist_enabled }]) : result();
    }
    if (query.startsWith('insert into orders')) {
      const [id, reference, packageId, amount, phone] = params;
      const plan = plans.find((item) => item.id === packageId);
      orders.set(id, { id, reference, package_id: packageId, packageName: plan.name, duration: plan.duration, amount, phone, status: 'INITIATING', payment_provider: 'COURTNEYTECH', created_at: new Date(NOW).toISOString() });
      return result([{ id }]);
    }
    if (query.startsWith('update outdoor_wifi_clients set order_id')) {
      subscriber.order_id = params[1];
      return result([{ id: subscriber.id }]);
    }
    if (query.startsWith('update orders set status=\'pending\'')) {
      const order = orders.get(params[0]);
      Object.assign(order, { status: 'PENDING', provider_checkout_id: params[1], provider_request_id: params[2], provider_transaction_id: params[3] });
      return result([{ id: order.id }]);
    }
    if (query.startsWith('update orders set status=\'paid\'')) {
      const order = orders.get(params[0]);
      if (!order || order.status !== 'PENDING') return result();
      Object.assign(order, { status: 'PAID', provider_transaction_id: params[1], mpesa_receipt: params[2], paid_at: new Date(NOW).toISOString() });
      return result([{ id: order.id }]);
    }
    if (query.startsWith('update outdoor_wifi_clients set package_id')) {
      Object.assign(subscriber, {
        package_id: params[1], package_name: params[2], package_price: params[3],
        activation_at: params[4], expected_expiry_at: params[5], status: 'ACTIVE', order_id: params[6], order_reference: params[7],
      });
      return result([{ id: subscriber.id }]);
    }
    if (query.startsWith('update orders set status=$2')) {
      const order = orders.get(params[0]);
      if (order) order.status = params[1];
      return result(order ? [{ id: order.id }] : []);
    }
    throw new Error(`Unexpected query: ${sql}`);
  }

  const db = {
    query: async (sql, params) => execute(sql, params),
    connect: async () => ({ query: async (sql, params) => execute(sql, params), release() {} }),
  };
  const courtneyClient = {
    isConfigured: () => true,
    async startStk(request) {
      startedPayment = request;
      return { checkoutRequestId: 'ws_CO_renewal123', merchantRequestId: 'merchant-1', transactionId: 'tx-1' };
    },
    async checkStatus() {
      return {
        status: providerStatus,
        checkoutRequestId: 'ws_CO_renewal123',
        transactionId: 'tx-1',
        phone: '254712345678',
        amount: 150,
        reference: startedPayment.reference,
        receipt: providerStatus === 'completed' ? 'QJK1234567' : null,
        resultCode: providerStatus === 'completed' ? '0' : null,
      };
    },
  };

  const app = express();
  app.use(express.json());
  app.use('/api/outdoor-wifi/portal', createOutdoorPortalRouter({
    db,
    now: () => NOW,
    createCode: () => '036914',
    deriveStatus,
    sendSms: async () => {},
    courtneyClient,
    sessionSecret: 'test-session-secret',
  }));
  const server = app.listen(0);
  return {
    get startedPayment() { return startedPayment; },
    set providerStatus(value) { providerStatus = value; },
    state: { subscriber, orders },
    url: new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('renewal only activates after CourtneyTech reports a matching completed payment', async (t) => {
  const runtime = createRuntime();
  t.after(runtime.close);
  const base = await runtime.url;

  await fetch(`${base}/api/outdoor-wifi/portal/request-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '0712345678' }),
  });
  const verifiedResponse = await fetch(`${base}/api/outdoor-wifi/portal/verify-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '0712345678', code: '036914' }),
  });
  const verified = await verifiedResponse.json();
  assert.equal(verifiedResponse.status, 200);

  const startedResponse = await fetch(`${base}/api/outdoor-wifi/portal/renewals/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${verified.sessionToken}` },
    body: JSON.stringify({ packageId: 'week' }),
  });
  const started = await startedResponse.json();
  assert.equal(startedResponse.status, 200);
  assert.equal(started.status, 'pending');
  assert.equal(runtime.startedPayment.phone, '254712345678');
  assert.equal(runtime.startedPayment.amount, 150);
  assert.match(runtime.startedPayment.reference, /^OW[A-F0-9]{10}$/);

  const pendingResponse = await fetch(`${base}/api/outdoor-wifi/portal/renewals/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${verified.sessionToken}` },
    body: JSON.stringify({ orderId: started.orderId }),
  });
  assert.equal((await pendingResponse.json()).status, 'pending');
  assert.equal(runtime.state.subscriber.package_name, 'Previous plan');

  runtime.providerStatus = 'completed';
  const completedResponse = await fetch(`${base}/api/outdoor-wifi/portal/renewals/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${verified.sessionToken}` },
    body: JSON.stringify({ orderId: started.orderId }),
  });
  const completed = await completedResponse.json();
  assert.equal(completedResponse.status, 200);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.subscriber.packageName, 'Weekly Unlimited');
  assert.equal(runtime.state.subscriber.package_name, 'Weekly Unlimited');
  assert.equal(runtime.state.subscriber.order_reference, runtime.state.orders.get(started.orderId).reference);
  assert.equal(runtime.state.orders.get(started.orderId).mpesa_receipt, 'QJK1234567');
});
