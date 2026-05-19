const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('content/plus-checkout.js', 'utf8');

test('plus checkout content script can be injected repeatedly on the same page', () => {
  const attrs = new Map();
  const context = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    location: { href: 'https://chatgpt.com/' },
    window: {},
    document: {
      documentElement: {
        getAttribute(name) {
          return attrs.get(name) || null;
        },
        setAttribute(name, value) {
          attrs.set(name, String(value));
        },
      },
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener() {},
        },
      },
    },
  };
  context.window = context;
  vm.createContext(context);

  vm.runInContext(source, context);
  vm.runInContext(source, context);

  assert.equal(context.__MULTIPAGE_PLUS_CHECKOUT_READY__, true);
});

function createPlusCheckoutMessageHarness({
  checkoutSessionId = 'cs_test_123',
  hostedUrl = 'https://checkout.stripe.com/c/pay/cs_hosted_123',
  hostedUrlField = 'url',
  location = { href: 'https://chatgpt.com/', host: 'chatgpt.com', pathname: '/' },
  documentExtras = {},
  bgFetchAddressResponse = null,
  scriptExtras = {},
} = {}) {
  const attrs = new Map();
  let listener = null;
  const fetchCalls = [];
  const sendMessageCalls = [];
  const document = {
    readyState: 'complete',
    documentElement: {
      getAttribute(name) {
        return attrs.get(name) || null;
      },
      setAttribute(name, value) {
        attrs.set(name, String(value));
      },
    },
    head: { appendChild() {} },
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), style: {}, textContent: '' };
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById(id) {
      return documentExtras.elements?.[id] || null;
    },
    ...(documentExtras.override || {}),
  };
  const context = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    location,
    window: {},
    document,
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
        sendMessage: async (msg) => {
          sendMessageCalls.push(msg);
          if (msg?.type === 'BG_FETCH_MEIGUODIZHI_ADDRESS' && bgFetchAddressResponse) {
            return bgFetchAddressResponse;
          }
          return null;
        },
      },
    },
    Event: class Event {
      constructor(type) { this.type = type; }
    },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    Object,
    resetStopState() {},
    isStopError() { return false; },
    throwIfStopped() {},
    sleep() { return Promise.resolve(); },
    log() {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      if (url === '/api/auth/session') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ accessToken: 'test-access-token' }),
        };
      }
      if (url === 'https://chatgpt.com/backend-api/payments/checkout') {
        const body = { checkout_session_id: checkoutSessionId };
        if (hostedUrl) {
          body[hostedUrlField] = hostedUrl;
        }
        return {
          ok: true,
          status: 200,
          json: async () => body,
        };
      }
      throw new Error(`unexpected fetch url: ${url}`);
    },
    ...scriptExtras,
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

  return { send, fetchCalls, sendMessageCalls };
}

test('CREATE_PLUS_CHECKOUT requests hosted Stripe long link with the script defaults and returns response url', async () => {
  const harness = createPlusCheckoutMessageHarness({
    checkoutSessionId: 'cs_hosted_paypal',
    hostedUrl: 'https://checkout.stripe.com/c/pay/cs_hosted_paypal_long',
  });

  const result = await harness.send({
    type: 'CREATE_PLUS_CHECKOUT',
    source: 'test',
    payload: {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_hosted_paypal_long');
  assert.equal(result.checkoutSessionId, 'cs_hosted_paypal');
  assert.equal(result.country, 'US');
  assert.equal(result.currency, 'USD');

  const checkoutCall = harness.fetchCalls.find((call) => call.url === 'https://chatgpt.com/backend-api/payments/checkout');
  assert.ok(checkoutCall);
  assert.equal(checkoutCall.options.method, 'POST');
  assert.equal(checkoutCall.options.headers.Authorization, 'Bearer test-access-token');
  const payload = JSON.parse(checkoutCall.options.body);
  assert.equal(payload.plan_name, 'chatgptplusplan');
  assert.equal(payload.checkout_ui_mode, 'hosted');
  assert.equal(payload.cancel_url, 'https://chatgpt.com/#pricing');
  assert.deepEqual(payload.billing_details, { country: 'US', currency: 'USD' });
  assert.deepEqual(payload.promo_campaign, {
    promo_campaign_id: 'plus-1-month-free',
    is_coupon_from_query_param: false,
  });
  assert.ok(!('entry_point' in payload), 'hosted payload should not carry legacy entry_point');
});

test('CREATE_PLUS_CHECKOUT also accepts stripe_hosted_url or checkout_url fallbacks for the long link', async () => {
  for (const field of ['stripe_hosted_url', 'checkout_url']) {
    const harness = createPlusCheckoutMessageHarness({
      checkoutSessionId: `cs_${field}`,
      hostedUrl: `https://checkout.stripe.com/c/pay/${field}_long`,
      hostedUrlField: field,
    });

    const result = await harness.send({
      type: 'CREATE_PLUS_CHECKOUT',
      source: 'test',
      payload: {},
    });

    assert.equal(result.ok, true, `should accept ${field} as hosted url source`);
    assert.equal(result.checkoutUrl, `https://checkout.stripe.com/c/pay/${field}_long`);
  }
});

test('CREATE_PLUS_CHECKOUT fails when response does not include any hosted long link field', async () => {
  const harness = createPlusCheckoutMessageHarness({
    checkoutSessionId: 'cs_missing_url',
    hostedUrl: null,
  });

  const result = await harness.send({
    type: 'CREATE_PLUS_CHECKOUT',
    source: 'test',
    payload: {},
  });

  assert.equal(result.ok, undefined);
  assert.match(result.error, /hosted 长链接/);
});

test('RUN_HOSTED_CHECKOUT_FLOW fills the hardcoded 2671 Clayton Oaks Dr billing address and submits the hosted checkout', async () => {
  const fills = [];
  const clicks = [];
  function makeInput(id, type = 'text') {
    const el = {
      id,
      type,
      tagName: 'INPUT',
      checked: false,
      value: '',
      options: type === 'select-one' ? [] : undefined,
      dispatchEvent() {},
      click() { clicks.push(id); el.checked = !el.checked; },
    };
    return el;
  }
  function makeSelect(id, options) {
    const opts = options.map((value) => ({ value, text: value }));
    return {
      id,
      tagName: 'SELECT',
      options: opts,
      value: '',
      dispatchEvent() {},
    };
  }
  function makeButton(testid, text = '提交') {
    const btn = {
      tagName: 'BUTTON',
      disabled: false,
      textContent: text,
      getAttribute() { return testid; },
      getBoundingClientRect() { return { height: 40, width: 200 }; },
      click() { clicks.push(`submit:${testid}`); },
    };
    return btn;
  }

  const submitBtn = makeButton('hosted-payment-submit-button');
  const paypalBtn = {
    tagName: 'BUTTON',
    click() { clicks.push('paypal-accordion'); },
  };
  const elements = {
    email: makeInput('email'),
    billingCountry: makeSelect('billingCountry', ['US', 'CA', 'GB']),
    billingAddressLine1: makeInput('billingAddressLine1'),
    billingLocality: makeInput('billingLocality'),
    billingPostalCode: makeInput('billingPostalCode'),
    billingAdministrativeArea: makeSelect('billingAdministrativeArea', ['CA', 'NY', 'TX', 'New York']),
    termsOfServiceConsentCheckbox: makeInput('termsOfServiceConsentCheckbox', 'checkbox'),
  };

  const harness = createPlusCheckoutMessageHarness({
    location: { href: 'https://checkout.stripe.com/c/pay/cs_xxx', host: 'checkout.stripe.com', pathname: '/c/pay/cs_xxx' },
    documentExtras: {
      elements,
      override: {
        querySelector(selector) {
          if (selector.includes('paypal-accordion-item-button') || selector.includes('paypal-accordion-item button')) {
            return paypalBtn;
          }
          if (selector.includes('hosted-payment-submit-button')) {
            return submitBtn;
          }
          return null;
        },
        querySelectorAll() { return []; },
      },
    },
  });

  // For setInputValue / fillById native setter to work without HTMLInputElement
  // descriptors we patch Object.getOwnPropertyDescriptor lookup to fall back
  // through the el.value direct assignment branch — the sandbox exposes a real
  // Object with no special descriptors on our plain element stubs, so the
  // function naturally falls back to `el.value = ...`.
  const result = await harness.send({
    type: 'RUN_HOSTED_CHECKOUT_FLOW',
    source: 'test',
    payload: {},
  });

  assert.equal(result.ok, true);
  // Hardcoded billing address — must not be re-fetched from meiguodizhi.com.
  // Compare field-by-field because the script returns an object frozen in a
  // separate vm realm, whose prototype trips deepStrictEqual.
  assert.equal(result.address.street, '2671 Clayton Oaks Drive');
  assert.equal(result.address.city, 'Dallas');
  assert.equal(result.address.state, 'TX');
  assert.equal(result.address.zip, '75227');
  // Random email should have been generated and filled.
  assert.match(elements.email.value, /^[a-z0-9]{16}@gmail\.com$/);
  assert.match(result.email, /^[a-z0-9]{16}@gmail\.com$/);
  // Country must be set to US so the state dropdown can match US options.
  assert.equal(elements.billingCountry.value, 'US');
  assert.equal(elements.billingAddressLine1.value, '2671 Clayton Oaks Drive');
  assert.equal(elements.billingLocality.value, 'Dallas');
  assert.equal(elements.billingPostalCode.value, '75227');
  // State select should land on the TX option.
  assert.equal(elements.billingAdministrativeArea.value, 'TX');
  // Terms checkbox should have been toggled.
  assert.ok(clicks.includes('termsOfServiceConsentCheckbox'));
  // PayPal accordion should have been clicked (twice per the reference script).
  const paypalClicks = clicks.filter((c) => c === 'paypal-accordion');
  assert.ok(paypalClicks.length >= 1);
  // Submit button should have been clicked.
  assert.ok(clicks.some((c) => c.startsWith('submit:')));
  // No background fetch — the address is hardcoded now.
  const bgCall = harness.sendMessageCalls.find((m) => m?.type === 'BG_FETCH_MEIGUODIZHI_ADDRESS');
  assert.equal(bgCall, undefined, 'hosted flow must not query meiguodizhi address anymore');
});

test('RUN_HOSTED_CHECKOUT_FLOW can pause before submit so background can switch proxy first', async () => {
  const clicks = [];
  function makeInput(id, type = 'text') {
    const el = {
      id,
      type,
      tagName: 'INPUT',
      checked: false,
      value: '',
      options: type === 'select-one' ? [] : undefined,
      dispatchEvent() {},
      click() { clicks.push(id); el.checked = !el.checked; },
    };
    return el;
  }
  function makeSelect(id, options) {
    const opts = options.map((value) => ({ value, text: value }));
    return {
      id,
      tagName: 'SELECT',
      options: opts,
      value: '',
      dispatchEvent() {},
    };
  }
  function makeButton(testid, text = '提交') {
    return {
      tagName: 'BUTTON',
      disabled: false,
      textContent: text,
      getAttribute() { return testid; },
      getBoundingClientRect() { return { height: 40, width: 200 }; },
      click() { clicks.push(`submit:${testid}`); },
    };
  }

  const submitBtn = makeButton('hosted-payment-submit-button');
  const paypalBtn = {
    tagName: 'BUTTON',
    click() { clicks.push('paypal-accordion'); },
  };
  const elements = {
    email: makeInput('email'),
    billingCountry: makeSelect('billingCountry', ['US', 'CA', 'GB']),
    billingAddressLine1: makeInput('billingAddressLine1'),
    billingLocality: makeInput('billingLocality'),
    billingPostalCode: makeInput('billingPostalCode'),
    billingAdministrativeArea: makeSelect('billingAdministrativeArea', ['CA', 'NY', 'TX']),
    termsOfServiceConsentCheckbox: makeInput('termsOfServiceConsentCheckbox', 'checkbox'),
  };

  const harness = createPlusCheckoutMessageHarness({
    location: { href: 'https://checkout.stripe.com/c/pay/cs_xxx', host: 'checkout.stripe.com', pathname: '/c/pay/cs_xxx' },
    documentExtras: {
      elements,
      override: {
        querySelector(selector) {
          if (selector.includes('paypal-accordion-item-button') || selector.includes('paypal-accordion-item button')) {
            return paypalBtn;
          }
          if (selector.includes('hosted-payment-submit-button')) {
            return submitBtn;
          }
          return null;
        },
        querySelectorAll() { return []; },
      },
    },
  });

  const prepareResult = await harness.send({
    type: 'RUN_HOSTED_CHECKOUT_FLOW',
    source: 'test',
    payload: { submit: false },
  });

  assert.equal(prepareResult.ok, true);
  assert.equal(prepareResult.readyForSubmit, true);
  assert.equal(prepareResult.submitted, false);
  assert.equal(elements.billingAddressLine1.value, '2671 Clayton Oaks Drive');
  assert.equal(elements.billingAdministrativeArea.value, 'TX');
  assert.equal(clicks.some((c) => c.startsWith('submit:')), false);

  const submitResult = await harness.send({
    type: 'RUN_HOSTED_CHECKOUT_SUBMIT',
    source: 'test',
    payload: {},
  });

  assert.equal(submitResult.ok, true);
  assert.equal(submitResult.submitted, true);
  assert.equal(clicks.some((c) => c.startsWith('submit:')), true);
});
