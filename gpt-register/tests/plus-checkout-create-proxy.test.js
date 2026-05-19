const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/create-plus-checkout.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageBackgroundPlusCheckoutCreate;`)(globalScope);

test('Plus checkout create opens hosted payment URL without switching to US proxy', async () => {
  const events = [];
  const tabId = 88;
  const checkoutUrl = 'https://pay.openai.com/checkout/test';
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async (message, level = 'info') => {
      events.push({ type: 'log', message, level });
    },
    applyRegionalProxy: async (region) => {
      events.push({ type: 'proxy', region });
    },
    chrome: {
      tabs: {
        create: async (payload) => {
          events.push({ type: 'create-tab', payload });
          return { id: tabId };
        },
        update: async (id, payload) => {
          events.push({ type: 'update-tab', id, payload });
          return { id, ...payload };
        },
      },
    },
    completeNodeFromBackground: async (step, payload) => {
      events.push({ type: 'complete', step, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async (sourceId, id) => {
      events.push({ type: 'ensure-ready', sourceId, id });
    },
    registerTab: async (sourceId, id) => {
      events.push({ type: 'register-tab', sourceId, id });
    },
    sendTabMessageUntilStopped: async () => ({
      checkoutUrl,
      country: 'US',
      currency: 'USD',
    }),
    setState: async (payload) => {
      events.push({ type: 'set-state', payload });
    },
    sleepWithStop: async (ms) => {
      events.push({ type: 'sleep', ms });
    },
    waitForTabCompleteUntilStopped: async (id) => {
      events.push({ type: 'wait-complete', id });
    },
  });

  await executor.executePlusCheckoutCreate();

  const checkoutUpdateIndex = events.findIndex((event) => (
    event.type === 'update-tab'
    && event.payload?.url === checkoutUrl
  ));
  const proxyIndex = events.findIndex((event) => event.type === 'proxy');
  assert.equal(proxyIndex, -1, 'step 6 should not switch to US proxy');
  assert.ok(checkoutUpdateIndex >= 0, 'hosted checkout URL should be opened');
});
