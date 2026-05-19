const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/paypal-approve.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageBackgroundPayPalApprove;`)(globalScope);

test('PayPal approve recovers when SMS fill navigates to Agree and Continue before the content response returns', async () => {
  const events = [];
  let currentUrl = 'https://www.paypal.com/checkoutweb/load';

  const chrome = {
    tabs: {
      async get(tabId) {
        assert.equal(tabId, 77);
        return { id: tabId, url: currentUrl, status: 'complete' };
      },
      async sendMessage(tabId, message) {
        events.push({ type: 'direct-message', messageType: message.type });
        assert.equal(tabId, 77);
        if (message.type === 'PAYPAL_FILL_SMS_CODE') {
          assert.equal(message.payload.code, '929278');
          currentUrl = 'https://www.paypal.com/authflow/consent/approve';
          throw new Error('message channel is closed');
        }
        if (message.type === 'PAYPAL_CLICK_CONSENT') {
          return { clicked: true };
        }
        throw new Error(`unexpected direct message: ${message.type}`);
      },
    },
  };

  const executor = api.createPayPalApproveExecutor({
    addLog: async (message, level = 'info') => {
      events.push({ type: 'log', message, level });
    },
    chrome,
    completeNodeFromBackground: async (nodeId, payload) => {
      events.push({ type: 'complete', nodeId, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {
      events.push({ type: 'ensure-ready', url: currentUrl });
    },
    getTabId: async (sourceName) => (sourceName === 'paypal-flow' ? 77 : null),
    isTabAlive: async (sourceName) => sourceName === 'paypal-flow',
    queryTabsInAutomationWindow: async () => [],
    sendTabMessageUntilStopped: async (tabId, sourceName, message) => {
      assert.equal(tabId, 77);
      assert.equal(sourceName, 'paypal-flow');
      events.push({ type: 'message', messageType: message.type });
      if (message.type === 'PAYPAL_GET_STATE') {
        return {
          url: currentUrl,
          pathname: new URL(currentUrl).pathname,
          looksLikeGuestLogin: false,
          looksLikeGuestCheckout: /\/checkoutweb\//i.test(currentUrl),
          hasEmailInput: false,
          hasCardInput: /\/checkoutweb\//i.test(currentUrl),
          hasSmsCodeInputs: /\/authflow\/code/i.test(currentUrl),
          hasConsentButton: /\/authflow\/consent\/approve/i.test(currentUrl),
        };
      }
      if (message.type === 'PAYPAL_RUN_GUEST_CHECKOUT') {
        currentUrl = 'https://www.paypal.com/authflow/code';
        return { email: 'guest@example.com' };
      }
      if (message.type === 'PAYPAL_WAIT_SMS_CODE') {
        return { code: '929278' };
      }
      throw new Error(`unexpected message: ${message.type}`);
    },
    setState: async (payload) => {
      events.push({ type: 'set-state', payload });
    },
    sleepWithStop: async (ms) => {
      events.push({ type: 'sleep', ms });
    },
    throwIfStopped: () => {},
    waitForTabCompleteUntilStopped: async () => {},
    waitForTabUrlMatchUntilStopped: async (tabId, matcher) => {
      assert.equal(tabId, 77);
      assert.equal(matcher(currentUrl), true);
      return { id: tabId, url: currentUrl };
    },
  });

  await executor.executePayPalApprove({
    bindCardNumber: '4859540158081157',
    paypalSmsPhone: '5822180725',
    paypalSmsApiUrl: 'https://sms.example.com/api?token=abc',
  });

  assert.deepEqual(
    events
      .filter((event) => event.type === 'message' || event.type === 'direct-message')
      .map((event) => event.messageType),
    [
      'PAYPAL_GET_STATE',
      'PAYPAL_RUN_GUEST_CHECKOUT',
      'PAYPAL_GET_STATE',
      'PAYPAL_WAIT_SMS_CODE',
      'PAYPAL_FILL_SMS_CODE',
      'PAYPAL_GET_STATE',
      'PAYPAL_CLICK_CONSENT',
    ]
  );
  assert.equal(
    events.some((event) => event.type === 'log' && /重新接管当前页面/.test(event.message)),
    true
  );
  assert.deepEqual(
    events.find((event) => event.type === 'complete'),
    {
      type: 'complete',
      nodeId: 'paypal-approve',
      payload: {
        plusPaypalApprovedAt: events.find((event) => event.type === 'complete').payload.plusPaypalApprovedAt,
        plusPaypalGuestEmail: 'guest@example.com',
        plusPaypalSmsCode: '929278',
      },
    }
  );
});
