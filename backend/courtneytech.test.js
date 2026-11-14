const test = require('node:test');
const assert = require('node:assert/strict');
const { createCourtneyTechClient } = require('./courtneytech');

const testEnv = {
  COURTNEY_BASE_URL: 'https://courtneytech.xyz/api',
  COURTNEY_API_KEY: 'test-api-key',
  COURTNEY_API_SECRET: 'test-api-secret',
  COURTNEY_ACCOUNT_ID: '17',
};

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('starts an STK request with server-side credentials and an account ID', async () => {
  let request;
  const client = createCourtneyTechClient({
    env: testEnv,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({ success: true, checkout_request_id: 'ws_CO_test123', transactionId: 'tx-1' });
    },
  });

  const result = await client.startStk({
    phone: '254712345678',
    amount: 150,
    reference: 'OWA1B2C3D4',
    callbackUrl: 'https://backend.test/api/webhooks/courtneytech',
  });

  assert.equal(request.url, 'https://courtneytech.xyz/api/v2/stkpush');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-API-Key'], 'test-api-key');
  assert.equal(request.options.headers['X-API-Secret'], 'test-api-secret');
  assert.deepEqual(JSON.parse(request.options.body), {
    payment_account_id: 17,
    phone: '254712345678',
    amount: 150,
    reference: 'OWA1B2C3D4',
    description: 'Outdoor renew',
    callback_url: 'https://backend.test/api/webhooks/courtneytech',
    success_callback_url: 'https://backend.test/api/webhooks/courtneytech',
    confirmation_url: 'https://backend.test/api/webhooks/courtneytech',
  });
  assert.equal(result.checkoutRequestId, 'ws_CO_test123');
});

test('checks a checkout request status and normalizes completed payment data', async () => {
  let request;
  const client = createCourtneyTechClient({
    env: testEnv,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({
        success: true,
        checkoutRequestId: 'ws_CO_test123',
        status: 'completed',
        transactionId: 'tx-1',
        phone: '254712345678',
        amountKes: 150,
        accountReference: 'OWA1B2C3D4',
        mpesaReceipt: 'QJK1234567',
      });
    },
  });

  const result = await client.checkStatus('ws_CO_test123');

  assert.equal(request.url, 'https://courtneytech.xyz/api/v2/status');
  assert.deepEqual(JSON.parse(request.options.body), { checkout_request_id: 'ws_CO_test123' });
  assert.deepEqual(result, {
    status: 'completed',
    checkoutRequestId: 'ws_CO_test123',
    transactionId: 'tx-1',
    phone: '254712345678',
    amount: 150,
    reference: 'OWA1B2C3D4',
    receipt: 'QJK1234567',
    resultCode: null,
  });
});

test('rejects payment requests when Render credentials are missing', async () => {
  const client = createCourtneyTechClient({ env: {}, fetchImpl: async () => { throw new Error('unexpected'); } });
  await assert.rejects(client.startStk({ phone: '254712345678', amount: 1, reference: 'OWA1B2C3D4' }), {
    code: 'COURTNEY_NOT_CONFIGURED',
    statusCode: 503,
  });
});
