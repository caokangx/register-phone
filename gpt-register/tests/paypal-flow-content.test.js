const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('content/paypal-flow.js', 'utf8');

function createHarness({
  pathname = '/checkoutweb/abc',
  elements = {},
  bgAddress = null,
  bgSmsResponses = [],
  consentButton = null,
} = {}) {
  let listener = null;
  const fetchCalls = [];
  const sendMessageCalls = [];
  const submitButtonClicks = [];

  const submitBtn = {
    tagName: 'BUTTON',
    disabled: false,
    textContent: '下一页',
    getAttribute: () => 'submit-button',
    getBoundingClientRect: () => ({ width: 200, height: 40 }),
    click() { submitButtonClicks.push('submit'); },
  };

  const document = {
    readyState: 'complete',
    documentElement: {
      _attrs: {},
      getAttribute(name) { return this._attrs[name] || null; },
      setAttribute(name, value) { this._attrs[name] = String(value); },
    },
    head: { appendChild() {} },
    createElement(tag) { return { tagName: String(tag).toUpperCase() }; },
    querySelector(selector) {
      if (selector === '#consentButton' || selector.includes('consentButton')) {
        return consentButton;
      }
      if (selector.includes('submit')) {
        return submitBtn;
      }
      return null;
    },
    querySelectorAll() { return []; },
    getElementById(id) { return elements[id] || null; },
  };

  let smsResponseIndex = 0;
  const context = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    location: {
      href: `https://www.paypal.com${pathname}`,
      host: 'www.paypal.com',
      pathname,
    },
    window: {},
    document,
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) { listener = fn; },
        },
        sendMessage: async (msg) => {
          sendMessageCalls.push(msg);
          if (msg?.type === 'BG_FETCH_MEIGUODIZHI_ADDRESS' && bgAddress) {
            return bgAddress;
          }
          if (msg?.type === 'BG_FETCH_PAYPAL_SMS_CODE') {
            if (smsResponseIndex < bgSmsResponses.length) {
              return bgSmsResponses[smsResponseIndex++];
            }
            return bgSmsResponses[bgSmsResponses.length - 1] || null;
          }
          return null;
        },
      },
    },
    Event: class Event { constructor(t) { this.type = t; } },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    Object,
    resetStopState() {},
    isStopError() { return false; },
    throwIfStopped() {},
    sleep() { return Promise.resolve(); },
    log() {},
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(typeof listener, 'function');

  async function send(message) {
    return await new Promise((resolve) => {
      listener(message, {}, resolve);
    });
  }

  return { send, fetchCalls, sendMessageCalls, submitButtonClicks, elements, submitBtn, document };
}

function makeInput(id) {
  return { id, tagName: 'INPUT', type: 'text', value: '', dispatchEvent() {} };
}

function makeSelect(id, optionValues) {
  return {
    id,
    tagName: 'SELECT',
    options: optionValues.map((value) => ({ value, text: value })),
    value: '',
    dispatchEvent() {},
  };
}

test('PAYPAL_RUN_GUEST_LOGIN fills a random gmail email and clicks submit on /pay', async () => {
  const elements = { email: makeInput('email') };
  const harness = createHarness({ pathname: '/pay', elements });

  const result = await harness.send({ type: 'PAYPAL_RUN_GUEST_LOGIN', source: 'test', payload: {} });

  assert.equal(result.ok, true);
  assert.match(elements.email.value, /^[a-z0-9]{16}@gmail\.com$/);
  assert.equal(result.email, elements.email.value);
  assert.ok(harness.submitButtonClicks.length >= 1);
});

test('PAYPAL_RUN_GUEST_CHECKOUT forces US, fills card/phone from payload, expiry/cvv hard-coded, address from background', async () => {
  const elements = {
    email: makeInput('email'),
    phone: makeInput('phone'),
    cardNumber: makeInput('cardNumber'),
    cardExpiry: makeInput('cardExpiry'),
    cardCvv: makeInput('cardCvv'),
    password: makeInput('password'),
    firstName: makeInput('firstName'),
    lastName: makeInput('lastName'),
    billingLine1: makeInput('billingLine1'),
    billingCity: makeInput('billingCity'),
    billingPostalCode: makeInput('billingPostalCode'),
    billingState: makeSelect('billingState', ['CA', 'NY', 'TX', 'New York']),
    country: makeSelect('country', ['US', 'CN']),
  };
  const harness = createHarness({
    pathname: '/checkoutweb/load',
    elements,
    bgAddress: {
      ok: true,
      address: { street: '742 Evergreen Terrace', city: 'Springfield', state: 'New York', zip: '10001' },
    },
  });

  const result = await harness.send({
    type: 'PAYPAL_RUN_GUEST_CHECKOUT',
    source: 'test',
    payload: { cardNumber: '4859540158081157', phone: '5822180725' },
  });

  assert.equal(result.ok, true);
  assert.equal(elements.country.value, 'US');
  assert.match(elements.email.value, /@gmail\.com$/);
  assert.equal(elements.phone.value, '5822180725');
  assert.equal(elements.cardNumber.value, '4859540158081157');
  assert.equal(elements.cardExpiry.value, '03 / 30');
  assert.equal(elements.cardCvv.value, '996');
  assert.equal(elements.firstName.value, 'James');
  assert.equal(elements.lastName.value, 'Smith');
  assert.equal(elements.billingLine1.value, '742 Evergreen Terrace');
  assert.equal(elements.billingCity.value, 'Springfield');
  assert.equal(elements.billingPostalCode.value, '10001');
  assert.equal(elements.billingState.value, 'New York');
  assert.ok(harness.submitButtonClicks.length >= 1);
  assert.ok(elements.password.value.length >= 14);
});

test('PAYPAL_RUN_GUEST_CHECKOUT errors out when card or phone are missing', async () => {
  const harness = createHarness({
    pathname: '/checkoutweb/load',
    elements: { country: makeSelect('country', ['US']) },
  });

  const result = await harness.send({
    type: 'PAYPAL_RUN_GUEST_CHECKOUT',
    source: 'test',
    payload: { cardNumber: '', phone: '' },
  });

  assert.equal(result.ok, undefined);
  assert.match(result.error, /(?:卡号|手机号)/);
});

test('PAYPAL_GET_STATE reports whether the page looks like /pay or /checkoutweb', async () => {
  const loginHarness = createHarness({ pathname: '/pay' });
  const loginResult = await loginHarness.send({ type: 'PAYPAL_GET_STATE', source: 'test', payload: {} });
  assert.equal(loginResult.looksLikeGuestLogin, true);
  assert.equal(loginResult.looksLikeGuestCheckout, false);

  const checkoutHarness = createHarness({ pathname: '/checkoutweb/load' });
  const checkoutResult = await checkoutHarness.send({ type: 'PAYPAL_GET_STATE', source: 'test', payload: {} });
  assert.equal(checkoutResult.looksLikeGuestLogin, false);
  assert.equal(checkoutResult.looksLikeGuestCheckout, true);
});

test('PAYPAL_GET_STATE treats /agreements/approve (Billing Agreement landing) as the guest-login phase', async () => {
  const harness = createHarness({ pathname: '/agreements/approve' });
  const result = await harness.send({ type: 'PAYPAL_GET_STATE', source: 'test', payload: {} });
  assert.equal(result.looksLikeGuestLogin, true);
  assert.equal(result.looksLikeGuestCheckout, false);
});

test('PAYPAL_RUN_SMS_VERIFY polls the API, fills six inputs with the extracted 6-digit code, and clicks #consentButton', async () => {
  const codeInputs = {};
  for (let i = 0; i < 6; i += 1) {
    codeInputs[`ci-ciBasic-${i}`] = makeInput(`ci-ciBasic-${i}`);
  }

  const consentClicks = [];
  const consentButton = {
    tagName: 'BUTTON',
    id: 'consentButton',
    disabled: false,
    textContent: 'Agree and Continue',
    getBoundingClientRect: () => ({ width: 320, height: 48 }),
    click() { consentClicks.push('consent'); },
  };

  const harness = createHarness({
    pathname: '/authflow/consent/code',
    elements: codeInputs,
    consentButton,
    bgSmsResponses: [
      // First poll: pending / no code yet.
      { ok: true, status: 200, text: 'no|empty|(PayPal)|到期时间：2026-06-29 00:00:00' },
      // Second poll: code arrives in the canonical reference format.
      { ok: true, status: 200, text: "yes|PayPal: 218356 is your security code. Don't share it.|(PayPal)|到期时间：2026-06-29 00:00:00" },
    ],
  });

  const result = await harness.send({
    type: 'PAYPAL_RUN_SMS_VERIFY',
    source: 'test',
    payload: { apiUrl: 'https://sms.example.com/api?token=abc' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, '218356');

  // Each input filled with exactly one digit, in order.
  assert.equal(codeInputs['ci-ciBasic-0'].value, '2');
  assert.equal(codeInputs['ci-ciBasic-1'].value, '1');
  assert.equal(codeInputs['ci-ciBasic-2'].value, '8');
  assert.equal(codeInputs['ci-ciBasic-3'].value, '3');
  assert.equal(codeInputs['ci-ciBasic-4'].value, '5');
  assert.equal(codeInputs['ci-ciBasic-5'].value, '6');

  // Both polls were sent to the background bridge with the configured URL.
  const smsCalls = harness.sendMessageCalls.filter((m) => m?.type === 'BG_FETCH_PAYPAL_SMS_CODE');
  assert.ok(smsCalls.length >= 2);
  for (const call of smsCalls) {
    assert.equal(call.payload.apiUrl, 'https://sms.example.com/api?token=abc');
  }

  // Consent button clicked.
  assert.deepEqual(consentClicks, ['consent']);
});

test('PAYPAL_RUN_SMS_VERIFY errors out when apiUrl is missing', async () => {
  const harness = createHarness({ pathname: '/authflow/consent/code' });
  const result = await harness.send({
    type: 'PAYPAL_RUN_SMS_VERIFY',
    source: 'test',
    payload: { apiUrl: '' },
  });
  assert.equal(result.ok, undefined);
  assert.match(result.error, /paypalSmsApiUrl/);
});
