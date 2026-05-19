const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/open-chatgpt.js', 'utf8');

function loadStep1Module() {
  const scope = {};
  return new Function('self', `${source}; return self.MultiPageBackgroundStep1;`)(scope);
}

test('step 1 cookie clear sweep covers ChatGPT/OpenAI domains AND PayPal domains', async () => {
  const api = loadStep1Module();
  const removedCookies = [];
  const browsingDataCalls = [];
  const logs = [];

  const allCookies = [
    { domain: 'chatgpt.com', name: 'cf_clearance', path: '/' },
    { domain: '.openai.com', name: 'oai_csrf', path: '/' },
    { domain: 'auth0.openai.com', name: 'auth0_session', path: '/' },
    { domain: '.paypal.com', name: 'x-pp-s', path: '/' },
    { domain: 'www.paypal.com', name: 'cookie_check', path: '/' },
    { domain: 'checkout.paypal.com', name: 'session', path: '/' },
    { domain: '.paypalobjects.com', name: 'akavpau', path: '/' },
    { domain: 'example.com', name: 'unrelated', path: '/' },
    { domain: 'google.com', name: 'NID', path: '/' },
  ];

  const chromeApi = {
    cookies: {
      getAllCookieStores: async () => [{ id: '0' }],
      getAll: async () => allCookies,
      remove: async (details) => {
        removedCookies.push(details);
        return { name: details.name };
      },
    },
    browsingData: {
      removeCookies: async (options) => {
        browsingDataCalls.push(options);
      },
    },
  };

  const executor = api.createStep1Executor({
    addLog: async (message, level) => { logs.push({ message, level }); },
    chrome: chromeApi,
    completeNodeFromBackground: async () => {},
    openSignupEntryTab: async () => {},
  });

  await executor.executeStep1();

  // OpenAI cookies cleared.
  assert.ok(removedCookies.some((c) => c.url.startsWith('https://chatgpt.com') && c.name === 'cf_clearance'));
  assert.ok(removedCookies.some((c) => c.url.startsWith('https://openai.com') && c.name === 'oai_csrf'));
  assert.ok(removedCookies.some((c) => c.url.startsWith('https://auth0.openai.com') && c.name === 'auth0_session'));

  // PayPal cookies cleared.
  assert.ok(removedCookies.some((c) => c.url.startsWith('https://paypal.com') && c.name === 'x-pp-s'), 'paypal.com root cookies should be cleared');
  assert.ok(removedCookies.some((c) => c.url.startsWith('https://www.paypal.com') && c.name === 'cookie_check'), 'www.paypal.com cookies should be cleared');
  assert.ok(removedCookies.some((c) => c.url.startsWith('https://checkout.paypal.com') && c.name === 'session'), 'checkout.paypal.com cookies should be cleared');
  assert.ok(removedCookies.some((c) => c.url.includes('paypalobjects.com') && c.name === 'akavpau'), 'paypalobjects.com cookies should be cleared');

  // Unrelated cookies left alone.
  assert.ok(!removedCookies.some((c) => c.name === 'unrelated'));
  assert.ok(!removedCookies.some((c) => c.name === 'NID'));

  // browsingData sweep was invoked with PayPal origins included.
  assert.equal(browsingDataCalls.length, 1);
  const origins = browsingDataCalls[0].origins;
  assert.ok(origins.includes('https://chatgpt.com'));
  assert.ok(origins.includes('https://paypal.com'));
  assert.ok(origins.includes('https://www.paypal.com'));
  assert.ok(origins.includes('https://checkout.paypal.com'));

  // The summary log mentions PayPal.
  assert.ok(logs.some((entry) => /PayPal/.test(entry.message) && /已清理/.test(entry.message)));
});

test('step 1 cookie clear skips gracefully when chrome.cookies API is missing', async () => {
  const api = loadStep1Module();
  const logs = [];
  let tabOpened = false;
  let nodeCompleted = false;

  const executor = api.createStep1Executor({
    addLog: async (message, level) => { logs.push({ message, level }); },
    chrome: {},
    completeNodeFromBackground: async () => { nodeCompleted = true; },
    openSignupEntryTab: async () => { tabOpened = true; },
  });

  await executor.executeStep1();

  assert.ok(logs.some((entry) => /不支持 cookies API/.test(entry.message)));
  assert.equal(tabOpened, true);
  assert.equal(nodeCompleted, true);
});
