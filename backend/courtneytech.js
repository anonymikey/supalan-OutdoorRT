const DEFAULT_BASE_URL = 'https://courtneytech.xyz/api';
const DEFAULT_TIMEOUT_MS = 15_000;

class CourtneyTechError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'CourtneyTechError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function createCourtneyTechClient({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const baseUrl = String(env.COURTNEY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  function credentials() {
    const apiKey = String(env.COURTNEY_API_KEY || '').trim();
    const apiSecret = String(env.COURTNEY_API_SECRET || '').trim();
    const paymentAccountId = Number(env.COURTNEY_ACCOUNT_ID);
    let baseIsTrusted = false;
    try {
      const url = new URL(baseUrl);
      baseIsTrusted = url.protocol === 'https:' && (url.hostname === 'courtneytech.xyz' || url.hostname.endsWith('.courtneytech.xyz'));
    } catch {}
    if (!baseIsTrusted || !apiKey || !apiSecret || !Number.isSafeInteger(paymentAccountId) || paymentAccountId < 1) {
      throw new CourtneyTechError('COURTNEY_NOT_CONFIGURED', 'CourtneyTech payment settings are missing on the backend.', 503);
    }
    return { apiKey, apiSecret, paymentAccountId };
  }

  async function post(path, payload) {
    const { apiKey, apiSecret } = credentials();
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'X-API-Secret': apiSecret,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CourtneyTechError('COURTNEY_UNAVAILABLE', 'CourtneyTech could not be reached. Please try again shortly.', 502);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      if (response.status === 401 || response.status === 403) {
        throw new CourtneyTechError('COURTNEY_AUTH_FAILED', 'CourtneyTech rejected the payment configuration. Please contact support.', 502);
      }
      if (response.status === 402) {
        throw new CourtneyTechError('COURTNEY_ACCOUNT_NOT_READY', 'CourtneyTech cannot accept this payment right now. Please contact support.', 502);
      }
      throw new CourtneyTechError('COURTNEY_REQUEST_FAILED', 'CourtneyTech could not process this request. Please try again shortly.', 502);
    }
    return data;
  }

  return {
    isConfigured() {
      try {
        credentials();
        return true;
      } catch {
        return false;
      }
    },

    async startStk({ phone, amount, reference, description = 'Outdoor renew', callbackUrl }) {
      const { paymentAccountId } = credentials();
      const data = await post('/v2/stkpush', {
        payment_account_id: paymentAccountId,
        phone,
        amount,
        reference,
        description,
        ...(callbackUrl ? {
          callback_url: callbackUrl,
          success_callback_url: callbackUrl,
          confirmation_url: callbackUrl,
        } : {}),
      });
      const checkoutRequestId = data.checkout_request_id || data.checkoutRequestId;
      if (data.success !== true || typeof checkoutRequestId !== 'string' || !checkoutRequestId) {
        throw new CourtneyTechError('COURTNEY_INVALID_RESPONSE', 'CourtneyTech returned an incomplete payment response.', 502);
      }
      return {
        checkoutRequestId,
        merchantRequestId: data.merchantRequestId || data.merchant_request_id || null,
        transactionId: data.transactionId || data.transaction_id || null,
      };
    },

    async checkStatus(checkoutRequestId) {
      const data = await post('/v2/status', { checkout_request_id: checkoutRequestId });
      const status = String(data.status || '').toLowerCase();
      if (!['pending', 'completed', 'cancelled', 'failed'].includes(status)) {
        throw new CourtneyTechError('COURTNEY_INVALID_STATUS', 'CourtneyTech returned an unknown payment status.', 502);
      }
      return {
        status,
        checkoutRequestId: data.checkoutRequestId || data.checkout_request_id || null,
        transactionId: data.transactionId || data.transaction_id || null,
        phone: data.phone || null,
        amount: data.amountKes ?? data.amount ?? null,
        reference: data.accountReference || data.reference || null,
        receipt: data.mpesaReceipt || data.mpesa_receipt || null,
        resultCode: data.resultCode ?? data.result_code ?? null,
      };
    },
  };
}

module.exports = { CourtneyTechError, createCourtneyTechClient };
