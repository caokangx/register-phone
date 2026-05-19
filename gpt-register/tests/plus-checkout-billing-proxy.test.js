const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/fill-plus-checkout.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageBackgroundPlusCheckoutBilling;`)(globalScope);

test('Plus checkout billing switches to US proxy after filling billing details and before clicking subscribe', async () => {
  const events = [];
  const tabId = 77;
  let getCount = 0;
  const executor = api.createPlusCheckoutBillingExecutor({
    addLog: async (message, level = 'info') => {
      events.push({ type: 'log', message, level });
    },
    applyRegionalProxy: async (region) => {
      events.push({ type: 'proxy', region });
    },
    chrome: {
      tabs: {
        get: async (id) => {
          getCount += 1;
          const url = getCount === 1
            ? 'https://pay.openai.com/checkout/test'
            : 'https://www.paypal.com/checkoutnow?token=test';
          events.push({ type: 'get-tab', id, url });
          return { id, url };
        },
      },
    },
    completeNodeFromBackground: async (step, payload) => {
      events.push({ type: 'complete', step, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async (sourceId, id) => {
      events.push({ type: 'ensure-ready', sourceId, id });
    },
    getTabId: async () => tabId,
    isTabAlive: async () => true,
    sendTabMessageUntilStopped: async (id, sourceId, message) => {
      events.push({ type: 'send', id, sourceId, message });
      if (message?.type === 'RUN_HOSTED_CHECKOUT_SUBMIT') {
        return { submitted: true };
      }
      return {
        address: {
          street: '2671 Clayton Oaks Dr',
          city: 'Dallas',
          state: 'TX',
          zip: '75227',
        },
      };
    },
    setState: async (payload) => {
      events.push({ type: 'set-state', payload });
    },
    sleepWithStop: async (ms) => {
      events.push({ type: 'sleep', ms });
    },
    throwIfStopped: () => {
      events.push({ type: 'stop-check' });
    },
    waitForTabCompleteUntilStopped: async (id) => {
      events.push({ type: 'wait-complete', id });
    },
  });

  await executor.executePlusCheckoutBilling({});

  const fillIndex = events.findIndex((event) => (
    event.type === 'send'
    && event.message?.type === 'RUN_HOSTED_CHECKOUT_FLOW'
  ));
  const submitIndex = events.findIndex((event) => (
    event.type === 'send'
    && event.message?.type === 'RUN_HOSTED_CHECKOUT_SUBMIT'
  ));
  const proxyIndex = events.findIndex((event) => event.type === 'proxy' && event.region === 'us');
  const paypalWaitIndex = events.findIndex((event, index) => (
    index > submitIndex
    && event.type === 'get-tab'
    && /paypal\.com/i.test(event.url)
  ));
  const completeIndex = events.findIndex((event) => event.type === 'complete' && event.step === 'plus-checkout-billing');

  assert.ok(fillIndex >= 0, 'hosted checkout billing details should be filled');
  assert.ok(submitIndex >= 0, 'hosted checkout subscribe button should be clicked');
  assert.ok(proxyIndex >= 0, 'US proxy switch should be called in step 7');
  assert.ok(paypalWaitIndex >= 0, 'step 7 should wait for PayPal after submission');
  assert.equal(events[fillIndex].message.payload.submit, false);
  assert.ok(fillIndex < proxyIndex, 'US proxy must switch after billing details are filled');
  assert.ok(proxyIndex < submitIndex, 'US proxy must be confirmed before clicking subscribe');
  assert.ok(submitIndex < paypalWaitIndex, 'step 7 should wait for PayPal after clicking subscribe');
  assert.ok(paypalWaitIndex < completeIndex, 'step 7 should complete after PayPal redirect is observed');
});
