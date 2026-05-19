// content/paypal-flow.js — PayPal hosted-checkout helper.
//
// Drives the PayPal pages the hosted Stripe checkout redirects into after
// step 7:
//   * /pay — fill a random guest email and submit ("下一页").
//   * /checkoutweb/ — force country=US, fill all guest checkout fields
//     (random email, random password, the user-configured PayPal SMS phone
//     and the user-configured bind-card 0-dollar card number, hard-coded
//     expiry 03/30 and CVV 996 from the reference script, fixed name
//     "James Smith", US address fetched from the background), and submit.
//   * SMS verification page (six #ci-ciBasic-0..5 inputs) — poll the
//     configured paypalSmsApiUrl via background bridge, extract the
//     6-digit code from "PayPal: NNNNNN" output, fill the inputs.
//   * PayPal consent page — wait for "Agree and Continue" and click it.

console.log('[MultiPage:paypal-flow] Content script loaded on', location.href);

const PAYPAL_FLOW_LISTENER_SENTINEL = 'data-multipage-paypal-flow-listener';

if (document.documentElement.getAttribute(PAYPAL_FLOW_LISTENER_SENTINEL) !== '1') {
  document.documentElement.setAttribute(PAYPAL_FLOW_LISTENER_SENTINEL, '1');

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      message.type === 'PAYPAL_GET_STATE'
      || message.type === 'PAYPAL_RUN_GUEST_LOGIN'
      || message.type === 'PAYPAL_RUN_GUEST_CHECKOUT'
      || message.type === 'PAYPAL_WAIT_SMS_CODE'
      || message.type === 'PAYPAL_FILL_SMS_CODE'
      || message.type === 'PAYPAL_CLICK_CONSENT'
      || message.type === 'PAYPAL_RUN_SMS_VERIFY'
    ) {
      resetStopState();
      handlePayPalCommand(message).then((result) => {
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
  console.log('[MultiPage:paypal-flow] 消息监听已存在，跳过重复注册');
}

async function performPayPalOperationWithDelay(metadata, operation) {
  const rootScope = typeof window !== 'undefined' ? window : globalThis;
  const gate = rootScope?.CodexOperationDelay?.performOperationWithDelay;
  return typeof gate === 'function' ? gate(metadata, operation) : operation();
}

async function handlePayPalCommand(message) {
  switch (message.type) {
    case 'PAYPAL_GET_STATE':
      return inspectPayPalState();
    case 'PAYPAL_RUN_GUEST_LOGIN':
      return runGuestLoginPage(message.payload || {});
    case 'PAYPAL_RUN_GUEST_CHECKOUT':
      return runGuestCheckoutPage(message.payload || {});
    case 'PAYPAL_WAIT_SMS_CODE':
      return runWaitSmsCode(message.payload || {});
    case 'PAYPAL_FILL_SMS_CODE':
      return runFillSmsCode(message.payload || {});
    case 'PAYPAL_CLICK_CONSENT':
      return runClickConsentPage(message.payload || {});
    case 'PAYPAL_RUN_SMS_VERIFY':
      return runSmsVerifyPage(message.payload || {});
    default:
      throw new Error(`paypal-flow.js 不处理消息：${message.type}`);
  }
}

async function waitForDocumentComplete() {
  const start = Date.now();
  while (document.readyState !== 'complete' && Date.now() - start < 20000) {
    throwIfStopped();
    await sleep(200);
  }
  await sleep(1000);
}

function inspectPayPalState() {
  const path = String(location.pathname || '');
  // /pay and /agreements/approve both show the "enter your email" prompt
  // before redirecting onto /checkoutweb for guest card entry — treat them
  // as the same guest-login phase so background dispatch picks the right
  // handler.
  const looksLikeGuestLogin = path === '/pay'
    || /\/pay$/i.test(path)
    || /\/agreements\/approve\b/i.test(path);
  const looksLikeGuestCheckout = /\/checkoutweb\//i.test(path);
  return {
    url: location.href,
    pathname: path,
    looksLikeGuestLogin,
    looksLikeGuestCheckout,
    hasEmailInput: Boolean(document.getElementById('email')),
    hasCardInput: Boolean(document.getElementById('cardNumber')),
    hasSmsCodeInputs: PAYPAL_SMS_CODE_INPUT_IDS.every((id) => Boolean(document.getElementById(id))),
    hasConsentButton: Boolean(findConsentButton()),
  };
}

function randEmail() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let local = '';
  for (let i = 0; i < 16; i += 1) {
    local += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${local}@gmail.com`;
}

function randPassword() {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const symbols = '!@#$%^';
  const all = lower + upper + digits + symbols;
  const pick = (set) => set[Math.floor(Math.random() * set.length)];
  const required = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  const remaining = [];
  for (let i = 0; i < 10; i += 1) {
    remaining.push(pick(all));
  }
  return required.concat(remaining).sort(() => Math.random() - 0.5).join('');
}

function setInputValue(el, val) {
  if (!el) return false;
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
    log(`PayPal：NOT FOUND #${id}`);
    return false;
  }
  setInputValue(el, val);
  log(`PayPal：#${id} = ${el.value}`);
  return true;
}

function fillSelectById(id, text) {
  const el = document.getElementById(id);
  if (!el) {
    log(`PayPal：NOT FOUND #${id}`);
    return false;
  }
  const needle = String(text || '').toLowerCase();
  for (const option of Array.from(el.options || [])) {
    const optionText = String(option.text || '').toLowerCase();
    const optionValue = String(option.value || '').toLowerCase();
    if (optionText.includes(needle) || optionValue.includes(needle)) {
      el.value = option.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      log(`PayPal：#${id} = ${option.text}`);
      return true;
    }
  }
  log(`PayPal：#${id} 无匹配项「${text}」`);
  return false;
}

function findSubmitButton() {
  const candidates = [
    'button[data-testid="submit-button"]',
    'button[data-atomic-wait-intent="Submit_Email"]',
    'button[type="submit"]',
  ];
  for (const selector of candidates) {
    const btn = document.querySelector(selector);
    if (btn) {
      return btn;
    }
  }
  const textCandidates = ['下一页', 'Next', 'Subscribe', 'Pay', 'Continue', 'Agree'];
  const buttons = Array.from(document.querySelectorAll('button'));
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim();
    if (textCandidates.includes(text)) {
      return btn;
    }
  }
  return null;
}

// PayPal's Hagrid React buttons (including `#consentButton` "Agree and Continue"
// and the /pay /checkoutweb submit) wire onClick through a pointer-event
// pipeline — a bare `el.click()` fires only the synthetic click event and the
// real handler stays put. Replay the full pointer + mouse lead-up the way a
// human gesture would, then call `.click()` so the React onClick still fires.
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

async function clickSubmit(label = 'submit') {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    throwIfStopped();
    const btn = findSubmitButton();
    if (btn) {
      if (btn.disabled) {
        await sleep(1000);
        continue;
      }
      const rect = btn.getBoundingClientRect();
      if (!rect || rect.height === 0) {
        await sleep(1000);
        continue;
      }
      await performPayPalOperationWithDelay(
        { stepKey: 'paypal-approve', kind: 'click', label },
        async () => {
          performRealUserClick(btn);
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
      log(`PayPal：已点击 ${(btn.textContent || '').trim() || label}`);
      return true;
    }
    await sleep(500);
  }
  throw new Error(`PayPal：在 20 秒内未找到 ${label} 按钮。`);
}

async function fetchAddressFromBackground() {
  let address = null;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BG_FETCH_MEIGUODIZHI_ADDRESS',
      source: 'paypal-flow',
      payload: { country: 'US' },
    });
    if (response?.address) {
      address = response.address;
    }
  } catch (error) {
    log(`PayPal：从后台获取地址失败：${error?.message || String(error || '')}`);
  }
  if (!address) {
    address = { street: '123 Main St', city: 'New York', state: 'New York', zip: '10001' };
  }
  log(`PayPal：使用账单地址 ${JSON.stringify(address)}`);
  return address;
}

async function runGuestLoginPage() {
  await waitForDocumentComplete();
  await sleep(2000);
  const email = randEmail();
  log(`PayPal /pay: email = ${email}`);
  fillById('email', email);
  await sleep(1000);
  await clickSubmit('next-after-email');
  return { email };
}

async function forceCountryToUS() {
  const select = document.getElementById('country');
  if (!select) {
    return false;
  }
  if (String(select.value || '').toUpperCase() === 'US') {
    return true;
  }
  select.value = 'US';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  log('PayPal /checkoutweb: 已将国家切到 US，等待页面刷新...');
  await sleep(3000);
  return true;
}

async function runGuestCheckoutPage(payload = {}) {
  await waitForDocumentComplete();
  await sleep(2000);

  await forceCountryToUS();

  const cardNumber = String(payload?.cardNumber || '').trim();
  const phone = String(payload?.phone || '').trim();
  const cardExpiry = '03 / 30';
  const cardCvv = '996';
  if (!cardNumber) {
    throw new Error('PayPal /checkoutweb: 缺少绑卡卡号 (state.bindCardNumber)。');
  }
  if (!phone) {
    throw new Error('PayPal /checkoutweb: 缺少 PayPal 接码手机号 (state.paypalSmsPhone)。');
  }

  const address = await fetchAddressFromBackground();
  const email = randEmail();
  const password = randPassword();
  log(`PayPal /checkoutweb: email = ${email}`);

  fillById('email', email);
  fillById('phone', phone);
  fillById('cardNumber', cardNumber);
  fillById('cardExpiry', cardExpiry);
  fillById('cardCvv', cardCvv);
  fillById('password', password);
  fillById('firstName', 'James');
  fillById('lastName', 'Smith');
  fillById('billingLine1', address.street);
  fillById('billingCity', address.city);
  fillById('billingPostalCode', address.zip);
  fillSelectById('billingState', address.state);

  await sleep(500);
  await clickSubmit('submit-checkoutweb');
  return { email, address };
}

// ---- PayPal SMS verification (six-input code page → Agree and Continue) ----

const PAYPAL_SMS_CODE_INPUT_IDS = [
  'ci-ciBasic-0',
  'ci-ciBasic-1',
  'ci-ciBasic-2',
  'ci-ciBasic-3',
  'ci-ciBasic-4',
  'ci-ciBasic-5',
];

function extractPayPalSmsCode(text = '') {
  const raw = String(text || '');
  if (!raw) return '';
  // Reference format: "yes|PayPal: 218356 is your security code. Don't share it.|(PayPal)|到期时间：..."
  const labelled = raw.match(/PayPal[^0-9]{0,40}(\d{6})/i);
  if (labelled) return labelled[1];
  // Fallback: any standalone 6-digit run (avoid grabbing inside a longer digit run).
  const generic = raw.match(/(?<!\d)(\d{6})(?!\d)/);
  return generic ? generic[1] : '';
}

async function fetchPayPalSmsCodeOnce(apiUrl) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BG_FETCH_PAYPAL_SMS_CODE',
      source: 'paypal-flow',
      payload: { apiUrl },
    });
    if (!response) return { code: '', text: '', error: '后台未返回响应' };
    if (response.error) return { code: '', text: String(response.text || ''), error: String(response.error || '') };
    const text = String(response.text || '');
    return { code: extractPayPalSmsCode(text), text };
  } catch (error) {
    return { code: '', text: '', error: error?.message || String(error || '') };
  }
}

async function waitForPayPalSmsCode(apiUrl, options = {}) {
  const timeoutMs = Math.max(15000, Number(options.timeoutMs) || 180000);
  const intervalMs = Math.max(1000, Number(options.intervalMs) || 4000);
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    throwIfStopped();
    attempt += 1;
    const { code, text, error } = await fetchPayPalSmsCodeOnce(apiUrl);
    if (code) {
      log(`PayPal SMS: 第 ${attempt} 次查询命中验证码 ${code}`);
      return code;
    }
    if (error) {
      log(`PayPal SMS: 第 ${attempt} 次查询失败 (${error})，将重试。`);
    } else if (text) {
      log(`PayPal SMS: 第 ${attempt} 次查询暂未拿到 6 位验证码（响应片段：${text.slice(0, 80)}）。`);
    } else {
      log(`PayPal SMS: 第 ${attempt} 次查询响应为空，将重试。`);
    }
    await sleep(intervalMs);
  }
  throw new Error('PayPal SMS: 等待接码平台返回 6 位验证码超时。');
}

// PayPal's Hagrid SMS code inputs are React-controlled and validate via the
// keydown/beforeinput pipeline — they record "did the user actually type
// this?" off keyboard events, not the DOM `value`. Bare `setInputValue`
// changes the visible value but PayPal's server still thinks no code was
// entered, so the consent button refuses to advance (even on a real manual
// click). Type each digit through the full keyboard-event sequence instead.
function typeDigitIntoInput(el, char) {
  if (!el) return false;
  try {
    if (typeof el.focus === 'function') el.focus();
  } catch {
    // ignore — focus is best-effort
  }
  const root = typeof globalThis !== 'undefined' ? globalThis : window;
  const code = char.charCodeAt(0);
  const keyInit = {
    bubbles: true,
    cancelable: true,
    key: char,
    code: `Digit${char}`,
    keyCode: code,
    which: code,
    charCode: 0,
  };
  const dispatch = (Ctor, type, init) => {
    if (typeof Ctor !== 'function') return;
    try {
      el.dispatchEvent(new Ctor(type, init));
    } catch {
      // ignore — synthetic events are best-effort
    }
  };
  dispatch(root.KeyboardEvent, 'keydown', keyInit);

  // beforeinput fires the InputEvent React looks at for validating "user input"
  const inputInit = { bubbles: true, cancelable: true, data: char, inputType: 'insertText' };
  dispatch(root.InputEvent, 'beforeinput', inputInit);

  // Use the native setter so React's internal value tracker sees a change and
  // schedules a state update when input fires.
  try {
    const proto = (typeof root.HTMLTextAreaElement === 'function' && el instanceof root.HTMLTextAreaElement)
      ? root.HTMLTextAreaElement.prototype
      : (typeof root.HTMLInputElement === 'function' ? root.HTMLInputElement.prototype : null);
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
    if (setter) {
      setter.call(el, String(char));
    } else {
      el.value = String(char);
    }
  } catch {
    el.value = String(char);
  }

  // Prefer InputEvent so React's onChange/onInput receives the actual data
  // payload; fall back to a plain Event when InputEvent isn't constructable
  // (older runtimes / the vm-based unit-test sandbox).
  try {
    if (typeof root.InputEvent === 'function') {
      el.dispatchEvent(new root.InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
    } else {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch {
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* ignore */ }
  }

  dispatch(root.KeyboardEvent, 'keyup', keyInit);

  try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch { /* ignore */ }
  return true;
}

async function fillSmsCodeInputs(code, options = {}) {
  const digits = String(code || '').replace(/\D/g, '').slice(0, 6);
  if (digits.length !== 6) {
    throw new Error(`PayPal SMS: 验证码长度不是 6 位（实际「${code}」）。`);
  }
  const interDigitDelayMs = Math.max(0, Number(options.interDigitDelayMs) || 120);
  for (let i = 0; i < PAYPAL_SMS_CODE_INPUT_IDS.length; i += 1) {
    const id = PAYPAL_SMS_CODE_INPUT_IDS[i];
    const el = document.getElementById(id);
    if (!el) {
      throw new Error(`PayPal SMS: 找不到验证码输入框 #${id}。`);
    }
    typeDigitIntoInput(el, digits[i]);
    // Small pause so PayPal's per-digit auto-advance + server-side validate
    // pipeline can run before we type the next character. Without this the
    // bursty value-writes can race ahead of the React state machine and the
    // code is never registered as "fully entered".
    if (i < PAYPAL_SMS_CODE_INPUT_IDS.length - 1 && interDigitDelayMs > 0) {
      await sleep(interDigitDelayMs);
    }
  }
  // Blur the last input so the framework's "complete" handler fires.
  const last = document.getElementById(PAYPAL_SMS_CODE_INPUT_IDS[5]);
  last?.blur?.();
  log(`PayPal SMS: 已填入 6 位验证码 ${digits}`);
  return digits;
}

function getElementButtonText(el) {
  if (!el) return '';
  const directText = String(el.textContent || '').replace(/\s+/g, ' ').trim();
  const valueText = String(el.value || '').replace(/\s+/g, ' ').trim();
  const ariaText = typeof el.getAttribute === 'function'
    ? String(el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
    : '';
  return directText || valueText || ariaText;
}

function findConsentButtonByText() {
  const candidates = Array.from(document.querySelectorAll(
    'button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]'
  ));
  const strongPatterns = [
    /^agree\s*(?:&|and)\s*continue$/i,
    /\bagree\s*(?:&|and)\s*continue\b/i,
    /同意.*继续/,
    /接受.*继续/,
  ];
  for (const el of candidates) {
    const text = getElementButtonText(el);
    if (strongPatterns.some((pattern) => pattern.test(text))) {
      return el;
    }
  }
  return null;
}

function findConsentButton() {
  return document.querySelector('#consentButton')
    || document.querySelector('button[data-testid="consentButton"]')
    || findConsentButtonByText()
    || null;
}

async function waitForConsentButton(timeoutMs = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    throwIfStopped();
    const btn = findConsentButton();
    if (btn) {
      const rect = btn.getBoundingClientRect?.();
      if (rect && rect.height > 0 && !btn.disabled) {
        return btn;
      }
    }
    await sleep(500);
  }
  throw new Error('PayPal SMS: 等待 “Agree and Continue” 按钮出现超时。');
}

async function clickConsentButton() {
  const btn = await waitForConsentButton();
  await performPayPalOperationWithDelay(
    { stepKey: 'paypal-approve', kind: 'click', label: 'consent-agree-and-continue' },
    async () => {
      performRealUserClick(btn);
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
  log('PayPal SMS: 已点击 “Agree and Continue”。');
}

async function runWaitSmsCode(payload = {}) {
  await waitForDocumentComplete();
  await sleep(1500);

  const apiUrl = String(payload?.apiUrl || '').trim();
  if (!apiUrl) {
    throw new Error('PayPal SMS: 未配置 paypalSmsApiUrl，无法查询验证码。');
  }

  log(`PayPal SMS: 准备从 ${apiUrl} 轮询接码平台...`);
  const code = await waitForPayPalSmsCode(apiUrl, {
    timeoutMs: Number(payload?.timeoutMs) || 180000,
    intervalMs: Number(payload?.intervalMs) || 4000,
  });

  return { code };
}

async function runFillSmsCode(payload = {}) {
  await waitForDocumentComplete();

  const code = String(payload?.code || '').trim();
  const filledCode = await fillSmsCodeInputs(code);

  return { code: filledCode };
}

async function runClickConsentPage() {
  await waitForDocumentComplete();
  await sleep(500);
  await clickConsentButton();

  return { clicked: true };
}

async function runSmsVerifyPage(payload = {}) {
  const { code } = await runWaitSmsCode(payload);
  await fillSmsCodeInputs(code);
  // PayPal validates the 6-digit code server-side after the last digit is
  // typed; give that round-trip time to finish (and the consent button time
  // to flip enabled) before we attempt the click.
  await sleep(2000);
  await clickConsentButton();

  return { code };
}
