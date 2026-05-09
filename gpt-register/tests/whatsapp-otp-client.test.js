const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadClientFactory() {
  delete globalThis.MultiPageWhatsappOtpClient;
  // eslint-disable-next-line no-new-func
  new Function(fs.readFileSync('background/whatsapp-otp.js', 'utf8'))();
  return globalThis.MultiPageWhatsappOtpClient.createWhatsappOtpClient;
}

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test('WhatsApp OTP polling clears phone notifications after reading a code', async () => {
  const calls = [];
  const logs = [];
  const createWhatsappOtpClient = loadClientFactory();
  const client = createWhatsappOtpClient({
    addLog: async (message, level = 'info') => logs.push({ message, level }),
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' });
      if (String(url).endsWith('/whatsapp/code')) {
        return jsonResponse({ code: '123456' });
      }
      if (String(url).endsWith('/notifications/clear')) {
        return jsonResponse({ ok: true, cleared: true });
      }
      throw new Error(`unexpected url: ${url}`);
    },
    sleepWithStop: async () => {},
  });

  const code = await client.pollOtp({}, {
    intervalMs: 500,
    timeoutMs: 3000,
    label: 'GoPay 验证码',
    stepLabel: '步骤 8',
  });

  assert.equal(code, '123456');
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ['GET', 'http://192.168.3.123:8000/whatsapp/code'],
    ['POST', 'http://192.168.3.123:8000/notifications/clear'],
  ]);
  assert.equal(logs.some((entry) => /清理手机通知/.test(entry.message)), true);
});

test('WhatsApp OTP polling still returns code when notification cleanup fails', async () => {
  const calls = [];
  const logs = [];
  const createWhatsappOtpClient = loadClientFactory();
  const client = createWhatsappOtpClient({
    addLog: async (message, level = 'info') => logs.push({ message, level }),
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' });
      if (String(url).endsWith('/whatsapp/code')) {
        return jsonResponse({ code: '654321' });
      }
      if (String(url).endsWith('/notifications/clear')) {
        return jsonResponse({ ok: false, message: 'clear failed' }, true);
      }
      throw new Error(`unexpected url: ${url}`);
    },
    sleepWithStop: async () => {},
  });

  const code = await client.pollOtp({}, {
    intervalMs: 500,
    timeoutMs: 3000,
    label: 'GoPay 验证码',
    stepLabel: '步骤 8',
  });

  assert.equal(code, '654321');
  assert.equal(calls.length, 2);
  assert.equal(logs.some((entry) => entry.level === 'warn' && /清理手机通知失败/.test(entry.message)), true);
});
