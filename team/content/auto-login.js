// 注入所有页面，仅在 flowActive 且 DOM 命中已知步骤特征时自动操作。
// 每个操作前后加入随机人性化延迟，规避风控（参考 flowpilot humanPause / 操作延迟）。
(function autoLogin() {
  const LOG_PREFIX = '[sub2api-auto:content]';
  const state = { flowActive: false, email: '', password: '', smsEnabled: false, phoneRequested: false };
  let busy = false;

  // 操作延迟参数（毫秒），模拟人工节奏
  const PRE_ACTION_MIN = 700;
  const PRE_ACTION_MAX = 1800;
  const FILL_CLICK_MIN = 600;
  const FILL_CLICK_MAX = 1500;
  const SETTLE_MS = 2000; // 每个步骤完成后的稳定等待（参考 flowpilot OPERATION_DELAY_MS）

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function humanPause(min, max) {
    return sleep(Math.floor(Math.random() * (max - min + 1)) + min);
  }

  function report(message, level = 'info', step = null) {
    console.log(LOG_PREFIX, message);
    try {
      chrome.runtime.sendMessage({ type: 'CONTENT_LOG', message, level, step });
    } catch { /* ignore */ }
  }

  // React 兼容填值：原生 setter + input/change 事件（移植自 flowpilot content/utils.js）
  function fillInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clickEl(el) {
    const form = el.form || el.closest?.('form') || null;
    if (el.type === 'submit' && form && typeof form.requestSubmit === 'function') {
      try { form.requestSubmit(el); return; } catch { /* fall through */ }
    }
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  function markDone(el) { el.dataset.s2aDone = '1'; }
  function isDone(el) { return el?.dataset?.s2aDone === '1'; }
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findButtonByText(re) {
    const buttons = document.querySelectorAll('button');
    for (const b of buttons) {
      if (isDone(b) || !visible(b)) continue;
      if (re.test((b.textContent || '').trim())) return b;
    }
    return null;
  }

  // 接码相关 DOM
  function getPhoneInput() {
    return document.querySelector('input[name="__reservedForPhoneNumberInput_tel"], input[type="tel"], input[autocomplete="tel"]');
  }
  function getCodeInput() {
    return document.querySelector('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]');
  }
  function getPhoneFormSubmit() {
    const form = document.querySelector('form[action*="/add-phone" i], form[action*="/phone-verification" i], form[action*="/contact-verification" i]');
    if (form) {
      const b = form.querySelector('button[type="submit"], input[type="submit"]');
      if (b && visible(b)) return b;
    }
    return findButtonByText(/继续|下一步|提交|验证|Continue|Next|Submit|Verify/i);
  }
  // 选择短信（SMS）验证方式的单选项
  function selectSmsRadio() {
    const radio = document.querySelector('input[type="radio"][value="sms"]');
    if (radio) {
      clickEl(radio);
      return true;
    }
    return false;
  }
  // 填手机号 → 选短信 → 继续
  async function fillPhoneAndSubmit(phoneNumber) {
    const tel = getPhoneInput();
    if (!tel) return false;
    await humanPause(PRE_ACTION_MIN, PRE_ACTION_MAX);
    fillInput(tel, `+${String(phoneNumber).replace(/^\+/, '')}`);
    await humanPause(FILL_CLICK_MIN, FILL_CLICK_MAX);
    if (selectSmsRadio()) await humanPause(300, 700);
    const submit = getPhoneFormSubmit();
    if (submit) clickEl(submit);
    return true;
  }
  function sendMsg(msg) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (res) => resolve(res || null)); } catch { resolve(null); }
    });
  }

  // 返回 true 表示本轮已执行一个动作
  async function step() {
    if (!state.flowActive || !state.email) return false;

    // 步骤4：SSO 登录表单（含密码框）—— 优先判断，避免与邮箱页混淆
    const ssoForm = document.querySelector('form[action$="/authorize"], form[action="/authorize"]');
    if (ssoForm) {
      const emailInput = ssoForm.querySelector('#email, input[name="email"], input[type="email"]');
      const passInput = ssoForm.querySelector('#password, input[name="password"], input[type="password"]');
      const submitBtn = ssoForm.querySelector('button[type="submit"], button');
      if (emailInput && passInput && submitBtn && !isDone(submitBtn)) {
        markDone(submitBtn);
        report('步骤4：填写 SSO 登录表单（邮箱+密码）', 'info', 4);
        await humanPause(PRE_ACTION_MIN, PRE_ACTION_MAX);
        if (!emailInput.value) fillInput(emailInput, state.email);
        await humanPause(FILL_CLICK_MIN, FILL_CLICK_MAX);
        fillInput(passInput, state.password);
        await humanPause(FILL_CLICK_MIN, FILL_CLICK_MAX);
        clickEl(submitBtn);
        report('步骤4：已提交登录', 'ok', 4);
        await sleep(SETTLE_MS);
        return true;
      }
    }

    // 步骤2：OpenAI 邮箱选择页
    const intentBtn = document.querySelector('button[name="intent"][value="email"]');
    const emailField = document.querySelector('input[name="email"][type="email"], input[name="email"]');
    if (intentBtn && emailField && !isDone(intentBtn) && visible(intentBtn)) {
      markDone(intentBtn);
      report('步骤2：填写邮箱并点击「继续」', 'info', 2);
      await humanPause(PRE_ACTION_MIN, PRE_ACTION_MAX);
      fillInput(emailField, state.email);
      await humanPause(FILL_CLICK_MIN, FILL_CLICK_MAX);
      clickEl(intentBtn);
      report(`步骤2：已提交邮箱 ${state.email}`, 'ok', 2);
      await sleep(SETTLE_MS);
      return true;
    }

    // 步骤3：选择 SSO 提供方
    const ssoBtn = document.querySelector('button[name="ssoConnection"]');
    if (ssoBtn && !isDone(ssoBtn) && visible(ssoBtn)) {
      markDone(ssoBtn);
      report('步骤3：点击 SSO 提供方', 'info', 3);
      await humanPause(PRE_ACTION_MIN, PRE_ACTION_MAX);
      clickEl(ssoBtn);
      report('步骤3：已选择 SSO 提供方', 'ok', 3);
      await sleep(SETTLE_MS);
      return true;
    }

    // 接码 A：手机验证页 —— 取号并填入手机号
    if (state.smsEnabled) {
      const telInput = getPhoneInput();
      if (telInput && visible(telInput) && !isDone(telInput)) {
        markDone(telInput);
        report('接码：检测到手机验证页，正在向接码平台取号...', 'info', 3);
        const res = await sendMsg({ type: 'REQUEST_PHONE_NUMBER' });
        if (!res?.ok) {
          report(`接码：取号失败：${res?.error || '未知错误'}`, 'error', 3);
          return true;
        }
        // 填号 → 选短信 → 继续
        await fillPhoneAndSubmit(res.phoneNumber);
        report(`接码：已填入手机号 +${res.phoneNumber}，已选短信验证并提交`, 'ok', 3);
        await sleep(SETTLE_MS);
        return true;
      }
    }

    // 接码 B：验证码页 —— 等待短信并填入（仅在已取号后处理，避免误判）
    if (state.smsEnabled && state.phoneRequested) {
      const codeInput = getCodeInput();
      if (codeInput && visible(codeInput) && !isDone(codeInput)) {
        markDone(codeInput);
        report('接码：等待短信验证码...', 'info', 3);
        const res = await sendMsg({ type: 'REQUEST_PHONE_CODE' });
        if (!res?.ok) {
          report(`接码：获取验证码失败：${res?.error || '未知错误'}`, 'error', 3);
          return true;
        }
        await humanPause(PRE_ACTION_MIN, PRE_ACTION_MAX);
        fillInput(codeInput, res.code);
        await humanPause(FILL_CLICK_MIN, FILL_CLICK_MAX);
        const submit = getPhoneFormSubmit();
        if (submit) clickEl(submit);
        report(`接码：已填入验证码 ${res.code} 并提交`, 'ok', 3);
        await sleep(SETTLE_MS);
        return true;
      }
    }

    // 步骤5：批准登录
    const approveBtn = findButtonByText(/批准登录|Approve/i);
    if (approveBtn) {
      markDone(approveBtn);
      report('步骤5：点击「批准登录」', 'info', 5);
      await humanPause(PRE_ACTION_MIN, PRE_ACTION_MAX);
      clickEl(approveBtn);
      report('步骤5：已批准登录', 'ok', 5);
      await sleep(SETTLE_MS);
      return true;
    }

    // 步骤6：OAuth 同意页「继续」
    const continueBtn = document.querySelector('button[data-dd-action-name="Continue"][type="submit"]:not([name="intent"])');
    if (continueBtn && !isDone(continueBtn) && visible(continueBtn)) {
      markDone(continueBtn);
      report('步骤6：点击「继续」完成授权', 'info', 6);
      await humanPause(PRE_ACTION_MIN, PRE_ACTION_MAX);
      clickEl(continueBtn);
      report('步骤6：已确认授权，等待回调...', 'ok', 6);
      await sleep(SETTLE_MS);
      return true;
    }

    return false;
  }

  async function tick() {
    if (busy || !state.flowActive) return;
    busy = true;
    try {
      await step();
    } catch (err) {
      report(`执行出错：${err.message}`, 'error');
    } finally {
      busy = false;
    }
  }

  // 初始化：读取运行状态
  chrome.storage.session.get(['flowActive', 'generatedEmail', 'generatedPassword', 'smsEnabled', 'phoneRequested']).then((s) => {
    state.flowActive = Boolean(s.flowActive);
    state.email = s.generatedEmail || '';
    state.password = s.generatedPassword || '';
    state.smsEnabled = Boolean(s.smsEnabled);
    state.phoneRequested = Boolean(s.phoneRequested);
    if (state.flowActive) tick();
  }).catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes.flowActive) state.flowActive = Boolean(changes.flowActive.newValue);
    if (changes.generatedEmail) state.email = changes.generatedEmail.newValue || '';
    if (changes.generatedPassword) state.password = changes.generatedPassword.newValue || '';
    if (changes.smsEnabled) state.smsEnabled = Boolean(changes.smsEnabled.newValue);
    if (changes.phoneRequested) state.phoneRequested = Boolean(changes.phoneRequested.newValue);
    if (state.flowActive) tick();
  });

  // 后台换号指令：用新号码重新填写并提交
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'REFILL_PHONE' && msg.phoneNumber) {
      report(`接码：收到换号指令，重新填入 +${msg.phoneNumber}`, 'info', 3);
      fillPhoneAndSubmit(msg.phoneNumber)
        .then((ok) => { if (ok) report('接码：已用新号重新提交', 'ok', 3); })
        .catch((err) => report(`接码：换号重填失败：${err.message}`, 'error', 3));
    }
  });

  // SPA 页面元素异步出现，用 MutationObserver 持续尝试
  const observer = new MutationObserver(() => tick());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 兜底轮询，覆盖 observer 漏掉的情况
  setInterval(tick, 1500);
})();
