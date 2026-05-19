// content/plus-checkout.js — ChatGPT Plus hosted-checkout helper.
//
// Two roles:
// 1) On chatgpt.com: provide accessToken and create a hosted Stripe checkout
//    session (step 6). Responds to CREATE_PLUS_CHECKOUT and
//    PLUS_CHECKOUT_GET_STATE.
// 2) On pay.openai.com / checkout.stripe.com (the hosted checkout page from
//    step 6): click the PayPal accordion, fill the billing address from a
//    background-fetched US address, check the terms checkbox, click submit
//    (step 7). Responds to RUN_HOSTED_CHECKOUT_FLOW and
//    RUN_HOSTED_CHECKOUT_SUBMIT.

(function attachPlusCheckoutContentScript() {
console.log('[MultiPage:plus-checkout] Content script loaded on', location.href);
window.__MULTIPAGE_PLUS_CHECKOUT_READY__ = true;

const PLUS_CHECKOUT_LISTENER_SENTINEL = 'data-multipage-plus-checkout-listener';
const PLUS_CHECKOUT_HOSTED_DEFAULTS = Object.freeze({
  plan_name: 'chatgptplusplan',
  billing_details: Object.freeze({
    country: 'US',
    currency: 'USD',
  }),
  cancel_url: 'https://chatgpt.com/#pricing',
  promo_campaign: Object.freeze({
    promo_campaign_id: 'plus-1-month-free',
    is_coupon_from_query_param: false,
  }),
  checkout_ui_mode: 'hosted',
});

async function performOperationWithDelay(metadata, operation) {
  const rootScope = typeof window !== 'undefined' ? window : globalThis;
  const gate = rootScope?.CodexOperationDelay?.performOperationWithDelay;
  return typeof gate === 'function' ? gate(metadata, operation) : operation();
}

if (document.documentElement.getAttribute(PLUS_CHECKOUT_LISTENER_SENTINEL) !== '1') {
  document.documentElement.setAttribute(PLUS_CHECKOUT_LISTENER_SENTINEL, '1');

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      message.type === 'CREATE_PLUS_CHECKOUT'
      || message.type === 'PLUS_CHECKOUT_GET_STATE'
      || message.type === 'RUN_HOSTED_CHECKOUT_FLOW'
      || message.type === 'RUN_HOSTED_CHECKOUT_SUBMIT'
    ) {
      resetStopState();
      handlePlusCheckoutCommand(message).then((result) => {
        sendResponse({ ok: true, ...(result || {}) });
      }).catch((err) => {
        if (isStopError(err)) {
          sendResponse({ stopped: true, error: err.message });
          return;
        }
        sendResponse({ error: err.message });
      });
      return true;
    }
  });
} else {
  console.log('[MultiPage:plus-checkout] 消息监听已存在，跳过重复注册');
}

async function handlePlusCheckoutCommand(message) {
  switch (message.type) {
    case 'CREATE_PLUS_CHECKOUT':
      return createPlusCheckoutSession();
    case 'PLUS_CHECKOUT_GET_STATE':
      return inspectPlusCheckoutState(message.payload || {});
    case 'RUN_HOSTED_CHECKOUT_FLOW':
      return runHostedCheckoutFlow(message.payload || {});
    case 'RUN_HOSTED_CHECKOUT_SUBMIT':
      return submitHostedCheckoutFlow(message.payload || {});
    default:
      throw new Error(`plus-checkout.js 不处理消息：${message.type}`);
  }
}

async function waitUntil(predicate, options = {}) {
  const intervalMs = Math.max(50, Math.floor(Number(options.intervalMs) || 250));
  const label = String(options.label || '条件').trim() || '条件';
  const timeoutMs = Math.max(0, Math.floor(Number(options.timeoutMs) || 0));
  const startedAt = Date.now();
  while (true) {
    throwIfStopped();
    const value = await predicate();
    if (value) {
      return value;
    }
    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      throw new Error(`${label}等待超时`);
    }
    await sleep(intervalMs);
  }
}

async function waitForDocumentComplete() {
  await waitUntil(() => document.readyState === 'complete', { intervalMs: 200, label: '页面加载' });
}

function inspectPlusCheckoutState(payload = {}) {
  const result = {
    url: location.href,
    readyState: document.readyState,
  };
  if (payload.includeAccessToken || payload.includeSession) {
    result.accessToken = ''; // resolved by createPlusCheckoutSession when needed
  }
  return result;
}

function extractHostedCheckoutUrl(data = {}) {
  return String(data?.url || data?.stripe_hosted_url || data?.checkout_url || '').trim();
}

async function createPlusCheckoutSession() {
  await waitForDocumentComplete();
  log('Plus：正在读取 ChatGPT 登录会话...');

  const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
  const session = await sessionResponse.json().catch(() => ({}));
  const accessToken = session?.accessToken;
  if (!accessToken) {
    throw new Error('请先登录 ChatGPT，当前页面未返回可用 accessToken。');
  }

  log('Plus：正在创建 hosted checkout 会话...');
  const checkoutPayload = JSON.parse(JSON.stringify(PLUS_CHECKOUT_HOSTED_DEFAULTS));
  const response = await fetch('https://chatgpt.com/backend-api/payments/checkout', {
    method: 'POST',
    credentials: 'include',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(checkoutPayload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.detail || data?.message || `HTTP ${response.status}`;
    throw new Error(`创建 Plus Checkout 失败：${detail}`);
  }

  const hostedUrl = extractHostedCheckoutUrl(data);
  if (!hostedUrl) {
    throw new Error('创建 Plus Checkout 失败：响应未返回 hosted 长链接（url / stripe_hosted_url / checkout_url 均为空）。');
  }

  return {
    checkoutUrl: hostedUrl,
    checkoutSessionId: String(data?.checkout_session_id || '').trim(),
    country: checkoutPayload.billing_details.country,
    currency: checkoutPayload.billing_details.currency,
  };
}

// ---- Hosted Stripe page (pay.openai.com / checkout.stripe.com) ----

function setInputValue(el, val) {
  if (!el) {
    return false;
  }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(el, String(val ?? ''));
  } else {
    el.value = String(val ?? '');
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
}

function fillById(id, val) {
  const el = document.getElementById(id);
  if (!el) {
    log(`Plus Checkout：NOT FOUND #${id}`);
    return false;
  }
  setInputValue(el, val);
  log(`Plus Checkout：#${id} = ${el.value}`);
  return true;
}

function fillSelectById(id, text) {
  const el = document.getElementById(id);
  if (!el) {
    log(`Plus Checkout：NOT FOUND #${id}`);
    return false;
  }
  const needle = String(text || '').toLowerCase();
  for (const option of Array.from(el.options || [])) {
    const optionText = String(option.text || '').toLowerCase();
    const optionValue = String(option.value || '').toLowerCase();
    if (optionText.includes(needle) || optionValue.includes(needle)) {
      el.value = option.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Plus Checkout：#${id} = ${option.text}`);
      return true;
    }
  }
  log(`Plus Checkout：#${id} 无匹配项「${text}」`);
  return false;
}

function randEmail() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let local = '';
  for (let i = 0; i < 16; i += 1) {
    local += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${local}@gmail.com`;
}

function findHostedSubmitButton() {
  const candidates = [
    'button[data-testid="hosted-payment-submit-button"]',
    'button[data-testid="submit-button"]',
    'button.SubmitButton--complete',
  ];
  for (const selector of candidates) {
    const btn = document.querySelector(selector);
    if (btn) {
      return btn;
    }
  }
  const textCandidates = ['Subscribe', 'Pay', 'Continue', 'Agree', '下一页', 'Next'];
  const buttons = Array.from(document.querySelectorAll('button'));
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim();
    if (textCandidates.includes(text)) {
      return btn;
    }
  }
  return null;
}

// Stripe's hosted submit button has a custom React handler bound through a
// pointer-event pipeline; a bare `el.click()` does not always trigger it.
// Replay the full pointer/mouse lead-up before calling `.click()` so the
// onPointerDown/onMouseDown listeners fire and the button visibly responds.
function performRealUserClick(el) {
  if (!el) return false;
  try {
    if (typeof el.focus === 'function') el.focus();
  } catch {
    // ignore — focus is best-effort
  }
  let clientX = 0;
  let clientY = 0;
  try {
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    if (rect) {
      clientX = rect.left + (rect.width || 0) / 2;
      clientY = rect.top + (rect.height || 0) / 2;
    }
  } catch {
    // ignore — coords are best-effort
  }
  const view = typeof window !== 'undefined' ? window : null;
  const mouseInit = { bubbles: true, cancelable: true, view, button: 0, buttons: 1, clientX, clientY };
  const pointerInit = { ...mouseInit, pointerType: 'mouse', isPrimary: true, pointerId: 1 };
  const root = typeof globalThis !== 'undefined' ? globalThis : window;
  const dispatch = (Ctor, type, init) => {
    if (typeof Ctor !== 'function') return;
    try {
      el.dispatchEvent(new Ctor(type, init));
    } catch {
      // ignore — synthetic events are best-effort
    }
  };
  dispatch(root.PointerEvent, 'pointerover', pointerInit);
  dispatch(root.PointerEvent, 'pointerenter', pointerInit);
  dispatch(root.MouseEvent, 'mouseover', mouseInit);
  dispatch(root.PointerEvent, 'pointerdown', pointerInit);
  dispatch(root.MouseEvent, 'mousedown', mouseInit);
  dispatch(root.PointerEvent, 'pointerup', pointerInit);
  dispatch(root.MouseEvent, 'mouseup', mouseInit);
  try {
    el.click?.();
  } catch {
    return false;
  }
  return true;
}

// Stripe's hosted submit button stays visually present but unclickable while
// its form validator is still running — `disabled` is NOT always set; instead
// the button carries `SubmitButton--incomplete` (or `--loading` during a
// submission). Only `SubmitButton--complete` means React's onClick will fire.
// Wait for that state — otherwise our pointer-event sequence lands while the
// handler is still a no-op and the click silently drops.
function isHostedSubmitReady(btn) {
  if (!btn) return false;
  if (btn.disabled) return false;
  const rect = typeof btn.getBoundingClientRect === 'function' ? btn.getBoundingClientRect() : null;
  if (!rect || !rect.height) return false;
  const className = String(btn.className || '');
  if (/\bSubmitButton--(incomplete|loading|disabled)\b/.test(className)) {
    return false;
  }
  // If the button uses Stripe's SubmitButton family at all, require the
  // explicit --complete marker. For non-Stripe fallbacks (plain Subscribe
  // buttons, etc.) the !disabled + visible check above is enough.
  if (/\bSubmitButton\b/.test(className) && !/\bSubmitButton--complete\b/.test(className)) {
    return false;
  }
  return true;
}

async function clickHostedSubmit() {
  const startedAt = Date.now();
  let loggedWaitForReady = false;
  while (Date.now() - startedAt < 30000) {
    throwIfStopped();
    const btn = findHostedSubmitButton();
    if (!btn) {
      await sleep(500);
      continue;
    }
    if (!isHostedSubmitReady(btn)) {
      if (!loggedWaitForReady) {
        log('Plus Checkout：订阅按钮尚未变为可点击状态（Stripe 正在校验表单），等待...');
        loggedWaitForReady = true;
      }
      await sleep(1000);
      continue;
    }
    await performOperationWithDelay(
      { stepKey: 'plus-checkout-hosted', kind: 'click', label: 'hosted-submit' },
      async () => {
        performRealUserClick(btn);
        // Backstop: if the button lives inside a <form>, ask the form to
        // submit through this button so Stripe's submit handler still wins
        // even if its pointer pipeline swallowed the click.
        try {
          const form = btn.form || (typeof btn.closest === 'function' ? btn.closest('form') : null);
          if (form && typeof form.requestSubmit === 'function') {
            form.requestSubmit(btn);
          }
        } catch {
          // ignore — requestSubmit fallback is best-effort
        }
      }
    );
    log(`Plus Checkout：已点击 ${(btn.textContent || '').trim() || '订阅按钮'}`);
    return true;
  }
  throw new Error('Plus Checkout：在 30 秒内订阅按钮未进入可点击状态。');
}

function findPayPalAccordionButton() {
  return document.querySelector('[data-testid="paypal-accordion-item-button"]')
    || document.querySelector('.paypal-accordion-item button')
    || null;
}

async function clickPayPalAccordion() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    throwIfStopped();
    const btn = findPayPalAccordionButton();
    if (btn) {
      await performOperationWithDelay(
        { stepKey: 'plus-checkout-hosted', kind: 'click', label: 'paypal-accordion' },
        async () => { btn.click(); }
      );
      log('Plus Checkout：已点击 PayPal 付款方式');
      // Re-click after a short delay (matches reference script behaviour).
      await sleep(500);
      const again = findPayPalAccordionButton();
      if (again) {
        await performOperationWithDelay(
          { stepKey: 'plus-checkout-hosted', kind: 'click', label: 'paypal-accordion-again' },
          async () => { again.click(); }
        );
      }
      return true;
    }
    await sleep(500);
  }
  log('Plus Checkout：未找到 PayPal accordion 按钮，将继续尝试填写账单地址（页面可能已默认选中 PayPal）。');
  return false;
}

// User-pinned billing address for the Stripe hosted checkout. Hardcoded per
// product owner — do not refetch from meiguodizhi.com here.
const HOSTED_CHECKOUT_BILLING_ADDRESS = Object.freeze({
  street: '2671 Clayton Oaks Drive',
  city: 'Dallas',
  state: 'TX',
  zip: '75227',
});

async function submitHostedCheckoutFlow() {
  // Give Stripe's form validator a real beat to flip the submit button from
  // SubmitButton--incomplete to SubmitButton--complete before we try to click.
  // clickHostedSubmit also waits for that class, but starting later means less
  // time burned on "still validating" log spam.
  await sleep(2500);
  await clickHostedSubmit();
  return { submitted: true };
}

async function runHostedCheckoutFlow(payload = {}) {
  await waitForDocumentComplete();
  log('Plus Checkout：开始执行 hosted 页面自动填写流程...');

  // Hide Stripe captcha / address autocomplete overlays to avoid blocking clicks.
  try {
    const style = document.createElement('style');
    style.textContent = '#captcha-standalone,.captcha-overlay,.captcha-container,.AddressAutocomplete-results{display:none!important;height:0!important;overflow:hidden!important}';
    document.head.appendChild(style);
  } catch {
    // ignore
  }

  await sleep(2000);
  await clickPayPalAccordion();
  await sleep(3000);

  const address = HOSTED_CHECKOUT_BILLING_ADDRESS;
  log(`Plus Checkout：使用固定账单地址 ${JSON.stringify(address)}`);
  const email = randEmail();

  fillById('email', email);
  // Country drives which states show up in billingAdministrativeArea — set it
  // first so the state select is repopulated with US options before we try to
  // match by address.state.
  fillSelectById('billingCountry', 'US');
  await sleep(500);

  fillById('billingAddressLine1', address.street);
  fillById('billingLocality', address.city);
  fillById('billingPostalCode', address.zip);
  fillSelectById('billingAdministrativeArea', address.state);

  const tos = document.getElementById('termsOfServiceConsentCheckbox');
  if (tos && !tos.checked) {
    try {
      tos.click();
      log('Plus Checkout：已勾选服务条款 checkbox');
    } catch (error) {
      log(`Plus Checkout：勾选服务条款失败：${error?.message || String(error || '')}`);
    }
  }

  const shouldSubmit = payload?.submit !== false && !payload?.prepareOnly;
  if (shouldSubmit) {
    await submitHostedCheckoutFlow();
  }
  return {
    address,
    email,
    readyForSubmit: true,
    submitted: shouldSubmit,
  };
}

}());
