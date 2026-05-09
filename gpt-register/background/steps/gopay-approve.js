(function attachBackgroundGoPayApprove(root, factory) {
  root.MultiPageBackgroundGoPayApprove = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundGoPayApproveModule() {
  const GOPAY_SOURCE = 'gopay-flow';
  const GOPAY_OTP_SOURCE = 'gopay-otp-flow';
  const PLUS_CHECKOUT_SOURCE = 'plus-checkout';
  const GOPAY_INJECT_FILES = ['content/utils.js', 'content/gopay-flow.js'];
  const GOPAY_WAIT_TIMEOUT_MS = 120000;
  const GOPAY_POLL_INTERVAL_MS = 1000;
  const GOPAY_LINKING_RETRY_WAIT_MS = 15000;
  const GOPAY_LINKING_STABLE_WAIT_MS = 60000;
  const GOPAY_TECHNICAL_ERROR_REFRESH_MAX_ATTEMPTS = 3;
  const GOPAY_MIDTRANS_BIND_MAX_ITERATIONS = 220;
  const GOPAY_MIDTRANS_BIND_URL_WAIT_MS = 55000;
  const GOPAY_MIDTRANS_TAB_CREATE_ATTEMPTS = 3;
  const GOPAY_OTP_FRAME_URL_PATTERN = /\/linking\/otp\b|gopayapi\.com\/linking\/otp/i;
  const GOPAY_PIN_FRAME_URL_PATTERN = /pin-web-client\.gopayapi\.com\/auth\/pin|\/auth\/pin\/verify|linking-validate-pin|merchants-gws-app\.gopayapi\.com\/payment\/validate-pin|\/payment\/validate-pin/i;
  const GOPAY_PAYMENT_FRAME_URL_PATTERN = /merchants-gws-app\.gopayapi\.com\/(?:payment\/details|app\/challenge)|\/gopay-tokenization\/pay/i;

  function createGoPayApproveExecutor(deps = {}) {
    const {
      addLog,
      chrome,
      completeStepFromBackground,
      ensureContentScriptReadyOnTabUntilStopped,
      getTabId,
      isTabAlive,
      registerTab,
      sendTabMessageUntilStopped,
      setState,
      sleepWithStop,
      waitForTabCompleteUntilStopped,
      clickWithDebugger = null,
      gopayOtpClient = null,
      throwIfStopped = null,
      getState = async () => ({}),
    } = deps;

    let stepId = 8;
    let stepLabel = '步骤 8';

    function normalizeText(value = '') {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function formatGoPayTerminalError(pageState = {}) {
      const terminalError = pageState?.terminalError || {};
      const terminalMessage = normalizeText(terminalError.message || 'GoPay 页面显示支付失败或会话已失效。');
      const rawText = normalizeText(terminalError.rawText || pageState?.textPreview || '');
      const rawSuffix = rawText ? ` 页面提示：${rawText.slice(0, 180)}` : '';
      return `${terminalMessage}${rawSuffix}`;
    }

    function createGoPayStableStateTracker() {
      let signature = '';
      let firstSeenAt = 0;
      return {
        update(pageState = {}, currentUrl = '') {
          const nextSignature = [
            pageState.url || currentUrl || '',
            pageState.hasPhoneInput ? 'phone' : '',
            pageState.hasOtpInput ? 'otp' : '',
            pageState.hasPinInput ? 'pin' : '',
            pageState.hasPayNowButton ? 'pay' : '',
            pageState.hasContinueButton ? 'continue' : '',
            normalizeText(pageState.textPreview || '').slice(0, 700),
          ].join('::');
          const now = Date.now();
          if (nextSignature !== signature) {
            signature = nextSignature;
            firstSeenAt = now;
          }
          return {
            signature,
            stableMs: firstSeenAt ? now - firstSeenAt : 0,
          };
        },
        reset() {
          signature = '';
          firstSeenAt = 0;
        },
      };
    }

    async function restartGoPayCheckoutFromStep6(tabId, reason = '') {
      const message = normalizeText(reason || 'GoPay 支付页已失效或点击后没有进入下一步。');
      await addLog(`${stepLabel}：${message} 正在关闭当前 GoPay/Checkout 页面，并回到步骤 6 重新创建 Plus Checkout。`, 'warn');
      if (Number.isInteger(tabId) && chrome?.tabs?.remove) {
        await chrome.tabs.remove(tabId).catch(() => {});
      }
      await setState({
        plusCheckoutTabId: null,
        plusCheckoutUrl: null,
        plusReturnUrl: '',
        plusPaypalApprovedAt: null,
        plusGoPayApprovedAt: null,
      });
      throw new Error(`GOPAY_RESTART_FROM_STEP6::${stepLabel}：${message} 已关闭当前支付页，请从步骤 6 重新创建 Plus Checkout。`);
    }

    async function requireGoPayManualIntervention(reason = '') {
      const message = normalizeText(reason || 'GoPay 页面显示技术错误，请手动处理后继续。');
      await addLog(`${stepLabel}：${message} 当前页面将保留，自动流程停止并等待人工处理。`, 'warn');
      throw new Error(`GOPAY_MANUAL_INTERVENTION_REQUIRED::${stepLabel}：${message} 当前页面已保留，请手动处理后继续。`);
    }

    async function refreshGoPayPageForTechnicalError(tabId, reason = '', attempt = 1) {
      const message = normalizeText(reason || 'GoPay 页面显示技术错误。');
      if (!Number.isInteger(tabId) || !chrome?.tabs?.reload) {
        await requireGoPayManualIntervention(`${message} 无法自动刷新当前页面。`);
        return;
      }
      if (attempt > GOPAY_TECHNICAL_ERROR_REFRESH_MAX_ATTEMPTS) {
        await requireGoPayManualIntervention(`${message} 自动刷新重试已达上限（${GOPAY_TECHNICAL_ERROR_REFRESH_MAX_ATTEMPTS} 次）。`);
        return;
      }
      await addLog(`${stepLabel}：${message} 正在自动刷新 GoPay 页面后重试（${attempt}/${GOPAY_TECHNICAL_ERROR_REFRESH_MAX_ATTEMPTS}）...`, 'warn');
      await chrome.tabs.reload(tabId).catch(async () => {
        await requireGoPayManualIntervention(`${message} 自动刷新失败。`);
      });
      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1500);
      return {
        reloaded: true,
        reason: message,
        attempt,
      };
    }

    function isMidtransCheckoutUrl(url = '') {
      return /app\.midtrans\.com/i.test(String(url || ''));
    }

    function isActivationBindingHostname(url = '') {
      try {
        const host = new URL(String(url || '').split('#')[0]).hostname.toLowerCase();
        return /(^|\.)gopayapi\.com$/i.test(host) || /\.gopay\.co\.id$/i.test(host);
      } catch (_) {
        return false;
      }
    }

    function authorizationPageLooksBrokenForBinding(pageState = {}) {
      const code = String(pageState?.terminalError?.code || '').trim().toLowerCase();
      if (code === 'technical-error') {
        return true;
      }
      const preview = normalizeText(pageState?.textPreview || '');
      const looksBad = pageState?.hasTerminalError
        || /technical\s+error|error\s+teknis|terjadi\s+kesalah|don't\s+worry.*try\s+again/i.test(preview);
      return Boolean(looksBad);
    }

    async function waitUntilActivationBindingLoads(bindingTabId, timeoutMs = GOPAY_MIDTRANS_BIND_URL_WAIT_MS) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        throwIfStopped?.();
        const t = await chrome.tabs.get(bindingTabId).catch(() => null);
        if (!t) {
          await sleepWithStop(300);
          continue;
        }
        const url = String(t.url || '');
        if (/^chrome-error:/i.test(url)) {
          await addLog(`${stepLabel}：authorization 标签页载入失败（Chrome 错误页）。`, 'warn');
          return false;
        }
        if (isActivationBindingHostname(url)) {
          await waitForTabCompleteUntilStopped(bindingTabId).catch(() => {});
          await sleepWithStop(500);
          return true;
        }
        await sleepWithStop(300);
      }
      await addLog(`${stepLabel}：等待 authorization 绑定页达到 gopayapi 超时。`, 'warn');
      return false;
    }

    async function createActivationBindingTab(absUrl = '') {
      const url = String(absUrl || '').trim();
      if (!url || !chrome?.tabs?.create) {
        return null;
      }
      for (let attempt = 1; attempt <= GOPAY_MIDTRANS_TAB_CREATE_ATTEMPTS; attempt += 1) {
        throwIfStopped?.();
        const created = await chrome.tabs.create({ url, active: true }).catch(() => null);
        if (!created?.id || !Number.isInteger(created.id)) {
          await sleepWithStop(700);
          continue;
        }
        await chrome.tabs.update(created.id, { active: true }).catch(() => {});
        if (await waitUntilActivationBindingLoads(created.id)) {
          return created.id;
        }
        await addLog(
          `${stepLabel}：authorization 页第 ${attempt}/${GOPAY_MIDTRANS_TAB_CREATE_ATTEMPTS} 次打开后未检测到 gopayapi，关闭并重试。`,
          'warn'
        );
        await chrome.tabs.remove(created.id).catch(() => {});
        await sleepWithStop(700);
      }
      return null;
    }

    async function runMidtransAuthorizeBindingFlow(bindingTabId, midtransTabId, flowState = {}) {
      const credentials = resolveGoPayCredentials(flowState || {});
      if (!credentials.phone) {
        await addLog(`${stepLabel}：无法在 authorization 自动绑定（缺 GoPay 手机号）。`, 'warn');
        return false;
      }
      await addLog(`${stepLabel}：正在 authorization（Midtrans linking）页面自动绑定…`, 'info');

      let phoneSubmitted = false;
      let otpSubmitted = false;
      let pinSubmitted = false;
      let idleStreak = 0;

      try {
        for (let i = 0; i < GOPAY_MIDTRANS_BIND_MAX_ITERATIONS; i += 1) {
          throwIfStopped?.();

          const peek = await chrome.tabs.get(bindingTabId).catch(() => null);
          if (!peek) {
            await addLog(`${stepLabel}：authorization 绑定页已关闭。`, 'warn');
            return false;
          }

          const peekUrl = String(peek.url || '');
          if (isReturnUrl(peekUrl)) {
            await addLog(`${stepLabel}：authorization 已回到 ChatGPT / OpenAI。`, 'ok');
            return true;
          }

          await ensureGoPayReady(bindingTabId, `${stepLabel}：authorization（Midtrans recovery）页面加载…`);

          const actionFrame = await findGoPayActionFrame(bindingTabId);
          const actionFrameId = actionFrame.frameId;
          const actionTargetId = actionFrame.targetId;

          let pageState;
          try {
            if (Number.isInteger(actionFrameId)) {
              await ensureGoPayOtpFrameReady(bindingTabId, actionFrameId);
            }
            pageState = actionTargetId
              ? await sendGoPayDebuggerTargetCommand(actionTargetId, 'GOPAY_GET_STATE', {})
              : (Number.isInteger(actionFrameId)
                ? await sendGoPayFrameCommand(bindingTabId, actionFrameId, 'GOPAY_GET_STATE', {})
                : await getGoPayState(bindingTabId));
          } catch (_) {
            await sleepWithStop(GOPAY_POLL_INTERVAL_MS);
            idleStreak += 1;
            continue;
          }

          if (!pageState) {
            await sleepWithStop(GOPAY_POLL_INTERVAL_MS);
            idleStreak += 1;
            continue;
          }

          if (authorizationPageLooksBrokenForBinding(pageState)) {
            await addLog(`${stepLabel}：authorization 仍显示技术错误或异常，停止自动绑定。`, 'warn');
            return false;
          }

          if (pageState.otpInvalid) {
            await addLog(`${stepLabel}：authorization 页面提示 OTP 错误，重新读取 WhatsApp 验证码。`, 'warn');
            otpSubmitted = false;
            await sleepWithStop(1000);
            if (!pageState.hasOtpInput || pageState.hasPinInput) {
              continue;
            }
          }

          if (pageState.completed) {
            await addLog(`${stepLabel}：authorization 显示已完成。`, 'ok');
            return true;
          }

          const progressing = Boolean(
            pageState.hasPhoneInput || pageState.hasOtpInput || pageState.hasPinInput
              || pageState.hasContinueButton || pageState.hasPayNowButton || pageState.otpInvalid
          );
          idleStreak = progressing ? 0 : idleStreak + 1;
          if (idleStreak > 180) {
            await addLog(`${stepLabel}：authorization 自动绑定超时（无可用控件）。`, 'warn');
            return false;
          }

          if (pageState.hasPhoneInput && !phoneSubmitted) {
            await sendGoPayCommand(bindingTabId, 'GOPAY_SUBMIT_PHONE', {
              countryCode: credentials.countryCode,
              phone: credentials.phone,
            });
            phoneSubmitted = true;
            otpSubmitted = false;
            pinSubmitted = false;
            await sleepWithStop(1400);
            continue;
          }

          if (pageState.hasPinInput && !pinSubmitted) {
            if (!credentials.pin) {
              await addLog(`${stepLabel}：authorization 需要 PIN，但侧边栏未配置 GoPay PIN。`, 'warn');
              return false;
            }
            if (actionTargetId) {
              await sendGoPayDebuggerTargetCommand(actionTargetId, 'GOPAY_SUBMIT_PIN', { pin: credentials.pin });
            } else if (Number.isInteger(actionFrameId)) {
              await ensureGoPayOtpFrameReady(bindingTabId, actionFrameId);
              await sendGoPayFrameCommand(bindingTabId, actionFrameId, 'GOPAY_SUBMIT_PIN', { pin: credentials.pin });
            } else {
              await sendGoPayCommand(bindingTabId, 'GOPAY_SUBMIT_PIN', { pin: credentials.pin });
            }
            pinSubmitted = true;
            await sleepWithStop(2200);
            continue;
          }

          if (pageState.hasOtpInput && !pageState.hasPinInput && !otpSubmitted) {
            const code = await fetchGoPayOtpFromApi(flowState);
            credentials.otp = code;
            if (actionTargetId) {
              await sendGoPayDebuggerTargetCommand(actionTargetId, 'GOPAY_SUBMIT_OTP', { code });
            } else if (Number.isInteger(actionFrameId)) {
              await ensureGoPayOtpFrameReady(bindingTabId, actionFrameId);
              await sendGoPayFrameCommand(bindingTabId, actionFrameId, 'GOPAY_SUBMIT_OTP', { code });
            } else {
              await sendGoPayCommand(bindingTabId, 'GOPAY_SUBMIT_OTP', { code });
            }
            otpSubmitted = true;
            await sleepWithStop(1400);
            continue;
          }

          if (pageState.hasPayNowButton) {
            if (actionTargetId) {
              await sendGoPayDebuggerTargetCommand(actionTargetId, 'GOPAY_CLICK_PAY_NOW', {});
            } else if (Number.isInteger(actionFrameId)) {
              await sendGoPayFrameCommand(bindingTabId, actionFrameId, 'GOPAY_CLICK_PAY_NOW', {});
            } else {
              await sendGoPayCommand(bindingTabId, 'GOPAY_CLICK_PAY_NOW', {});
            }
            await sleepWithStop(2400);
            continue;
          }

          if (pageState.hasContinueButton) {
            if (actionTargetId) {
              await sendGoPayDebuggerTargetCommand(actionTargetId, 'GOPAY_CLICK_CONTINUE', {});
            } else if (Number.isInteger(actionFrameId)) {
              await sendGoPayFrameCommand(bindingTabId, actionFrameId, 'GOPAY_CLICK_CONTINUE', {});
            } else {
              await clickGoPayContinueBestEffort(bindingTabId);
            }
            await sleepWithStop(2000);
            continue;
          }

          await sleepWithStop(GOPAY_POLL_INTERVAL_MS);
        }

        await addLog(`${stepLabel}：authorization 自动绑定超过最大迭代。`, 'warn');
        return false;
      } finally {
        await registerTab(GOPAY_SOURCE, midtransTabId).catch(() => {});
        await chrome.tabs.update(midtransTabId, { active: true }).catch(() => {});
      }
    }

    async function attemptMidtransLinkingTechnicalRecovery(tabId, context = {}) {
      if (!chrome?.tabs?.get || !chrome?.scripting?.executeScript || !Number.isInteger(tabId)) {
        return null;
      }

      const tabPeek = await chrome.tabs.get(tabId).catch(() => null);
      if (!isMidtransCheckoutUrl(String(tabPeek?.url || ''))) {
        return null;
      }

      const flowStateRaw = context?.flowState;
      const flowState = flowStateRaw && typeof flowStateRaw === 'object' ? flowStateRaw : await getState();

      try {
        const injections = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: 'MAIN',
          func: async () => {
            const replay = globalThis.__MULTIPAGE_midtransReplayLinkingWithoutAuth__;
            if (typeof replay !== 'function') {
              return { ok: false, error: 'hook_missing' };
            }
            return await replay({ skipWindowOpen: true });
          },
        });

        const results = Array.isArray(injections)
          ? injections.map((entry) => entry && entry.result).filter((r) => r && typeof r === 'object')
          : [];

        const hit = results.find((entry) => entry.ok === true && entry.activation_link_url);
        const activationLink = String(hit?.activation_link_url || '').trim();

        if (!hit || !activationLink) {
          const err = results.map((entry) => entry?.error).find(Boolean);
          await addLog(
            `${stepLabel}：Midtrans linking 自愈未拿到 activation_link_url${err ? `（${String(err)}）` : ''}。`,
            'info'
          );
          return null;
        }

        await addLog(
          `${stepLabel}：linking 重放成功，正在创建浏览器标签并核验 authorization 绑定页载入…`,
          'warn'
        );

        const bindingTabId = await createActivationBindingTab(activationLink);
        if (!Number.isInteger(bindingTabId)) {
          await addLog(`${stepLabel}：authorization 绑定页未能可靠打开。`, 'warn');
          await registerTab(GOPAY_SOURCE, tabId).catch(() => {});
          return null;
        }

        await runMidtransAuthorizeBindingFlow(bindingTabId, tabId, flowState);

        await chrome.tabs.reload(tabId).catch(() => {});
        await waitForTabCompleteUntilStopped(tabId);
        await sleepWithStop(1500);

        return {
          reloaded: true,
          reason: 'midtrans_linking_replay_recovery',
          midtransRecovery: true,
        };
      } catch (err) {
        await registerTab(GOPAY_SOURCE, tabId).catch(() => {});
        await addLog(
          `${stepLabel}：Midtrans linking 自愈异常：${normalizeText(err?.message || err)}`,
          'warn'
        );
        return null;
      }
    }

    async function handleGoPayTerminalError(pageState = {}, tabId = null, context = {}) {
      if (pageState?.hasTerminalError || pageState?.terminalError) {
        const terminalCode = String(pageState?.terminalError?.code || '').trim().toLowerCase();
        if (terminalCode === 'technical-error') {
          const snapshot = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
          const address = String(snapshot?.url || '');
          if (isMidtransCheckoutUrl(address)) {
            const midtransReload = await attemptMidtransLinkingTechnicalRecovery(tabId, context);
            if (midtransReload?.reloaded) {
              return midtransReload;
            }
            await requireGoPayManualIntervention(
              `${formatGoPayTerminalError(pageState)} 已停止 Midtrans 自动刷新；自愈未生效时请人工处理后继续步骤 8。`
            );
            return null;
          }
          return await refreshGoPayPageForTechnicalError(
            tabId,
            formatGoPayTerminalError(pageState),
            Number(context?.technicalErrorRefreshAttempts || 1)
          );
        }
        await restartGoPayCheckoutFromStep6(tabId, formatGoPayTerminalError(pageState));
      }
      return null;
    }

    function isGoPayUrl(url = '') {
      return /gopay|gojek|midtrans|xendit|stripe|checkout/i.test(String(url || ''))
        && !/chatgpt\.com\/checkout/i.test(String(url || ''));
    }

    function isReturnUrl(url = '') {
      const value = String(url || '');
      return /https:\/\/(?:chatgpt\.com|chat\.openai\.com|openai\.com)\//i.test(value)
        && !/gopay|gojek|midtrans|xendit|stripe/i.test(value)
        && !/\/checkout(?:[\/?#]|$)/i.test(value);
    }

    async function findOpenTabId(predicate) {
      if (!chrome?.tabs?.query) {
        return 0;
      }
      const tabs = await chrome.tabs.query({}).catch(() => []);
      const candidates = (Array.isArray(tabs) ? tabs : [])
        .filter((tab) => Number.isInteger(tab?.id) && predicate(tab.url || ''));
      if (!candidates.length) {
        return 0;
      }
      const match = candidates.find((tab) => tab.active && tab.currentWindow)
        || candidates.find((tab) => tab.active)
        || candidates[0];
      if (match?.id && chrome?.tabs?.update) {
        await chrome.tabs.update(match.id, { active: true }).catch(() => {});
      }
      return match?.id || 0;
    }

    async function resolveGoPayTabId(state = {}) {
      const registeredGoPayTabId = await getTabId(GOPAY_SOURCE);
      if (registeredGoPayTabId && await isTabAlive(GOPAY_SOURCE)) {
        return registeredGoPayTabId;
      }
      const discoveredGoPayTabId = await findOpenTabId(isGoPayUrl);
      if (discoveredGoPayTabId) {
        await addLog(`${stepLabel}：已从当前浏览器标签中发现 GoPay 页面，正在接管继续执行。`, 'info');
        if (typeof registerTab === 'function') {
          await registerTab(GOPAY_SOURCE, discoveredGoPayTabId);
        }
        return discoveredGoPayTabId;
      }
      const checkoutTabId = await getTabId(PLUS_CHECKOUT_SOURCE);
      if (checkoutTabId) {
        if (typeof registerTab === 'function') {
          await registerTab(GOPAY_SOURCE, checkoutTabId);
        }
        return checkoutTabId;
      }
      const storedTabId = Number(state.plusCheckoutTabId) || 0;
      if (storedTabId) {
        if (typeof registerTab === 'function') {
          await registerTab(GOPAY_SOURCE, storedTabId);
        }
        return storedTabId;
      }
      throw new Error(`${stepLabel}：未找到 GoPay 标签页，请先完成步骤 6。`);
    }

    async function ensureGoPayReady(tabId, logMessage = '') {
      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(800);
      await ensureContentScriptReadyOnTabUntilStopped(GOPAY_SOURCE, tabId, {
        inject: GOPAY_INJECT_FILES,
        injectSource: GOPAY_SOURCE,
        logMessage: logMessage || `${stepLabel}：GoPay 页面仍在加载，等待脚本就绪...`,
      });
    }

    async function getTabFrames(tabId) {
      if (!chrome?.webNavigation?.getAllFrames) {
        return [{ frameId: 0, url: '' }];
      }
      const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
      if (!Array.isArray(frames) || !frames.length) {
        return [{ frameId: 0, url: '' }];
      }
      return frames
        .filter((frame) => Number.isInteger(frame?.frameId))
        .sort((left, right) => Number(left.frameId) - Number(right.frameId));
    }

    function isGoPayOtpFrameUrl(url = '') {
      return GOPAY_OTP_FRAME_URL_PATTERN.test(String(url || ''));
    }

    function isGoPayPinFrameUrl(url = '') {
      return GOPAY_PIN_FRAME_URL_PATTERN.test(String(url || ''));
    }

    function isGoPayPaymentFrameUrl(url = '') {
      return GOPAY_PAYMENT_FRAME_URL_PATTERN.test(String(url || ''));
    }

    async function inspectGoPayFramesByDom(tabId) {
      if (!chrome?.scripting?.executeScript) {
        return [];
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => {
            const normalize = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
            const visible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect?.();
              const style = window.getComputedStyle?.(el);
              return Boolean(rect && rect.width > 0 && rect.height > 0)
                && (!style || (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0));
            };
            const controls = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
              .filter((el) => visible(el) && !el.disabled && el.getAttribute?.('aria-disabled') !== 'true');
            const inputs = Array.from(document.querySelectorAll('input, textarea')).filter(visible);
            const text = normalize(document.body?.innerText || document.body?.textContent || '');
            const controlTexts = controls.map((el) => normalize([
              el.textContent,
              el.value,
              el.getAttribute?.('data-testid'),
              el.getAttribute?.('aria-label'),
              el.getAttribute?.('title'),
              el.id,
            ].filter(Boolean).join(' ')));
            const inputHints = inputs.map((el) => normalize([
              el.getAttribute?.('data-testid'),
              el.getAttribute?.('aria-label'),
              el.getAttribute?.('placeholder'),
              el.getAttribute?.('name'),
              el.id,
              el.className,
              el.type,
              el.inputMode,
            ].filter(Boolean).join(' ')));
            const hasTerminalError = /waktunya\s+habis|ulang(?:i)?\s+prosesnya\s+dari\s+awal|time(?:'s|\s+is)?\s+(?:out|expired)|session\s+expired|expired|technical\s+error|terjadi\s+kesalahan|payment\s+failed|pembayaran\s+gagal|transaksi\s+gagal|declined|failed/i.test(text);
            const otpInvalid = /kode\s*otp(?:[-\s]*nya)?\s*salah|otp(?:\s*(?:is|nya))?\s*(?:salah|incorrect|invalid|wrong)|kode\s*(?:salah|tidak\s+valid)|mohon\s+cek\s+ulang|coba\s+lagi/i.test(text);
            const isPinPage = /pin|6\s*digit|masukkin\s+pin|masukkan\s+pin|ketik\s+6\s+digit|enter\s+pin|支付密码/i.test(text)
              || /pin-web-client\.gopayapi\.com|\/auth\/pin|\/payment\/validate-pin|linking-validate-pin/i.test(location.href || '');
            const hasPinInput = isPinPage
              || inputHints.some((hint) => /pin-input|(?:^|[\s_-])pin(?:$|[\s_-])|password|numeric|支付密码/i.test(hint));
            const hasOtpInput = !hasPinInput && (/otp|one[-\s]*time|kode|verification|whatsapp|验证码|短信/i.test(text)
              || inputHints.some((hint) => /otp|code|kode|verification|whatsapp/i.test(hint)));
            const hasPayNowButton = controlTexts.some((item) => /^\s*pay\s+now\s*$/i.test(item)
              || /^\s*bayar(?:\s+sekarang)?(?:\s*rp[\s\S]*)?\s*$/i.test(item)
              || /^\s*bayar\b[\s\S]*$/i.test(item)
              || /(?:^|\s)pay-button(?:\s|$)/i.test(item));
            const hasContinueButton = controlTexts.some((item) => /continue|next|submit|verify|confirm|authorize|allow|lanjut|lanjutkan|berikut|kirim|konfirmasi|hubungkan|sambungkan|tautkan|setuju|izinkan|link|继续|下一步|提交|验证|确认|授权|绑定|关联/i.test(item));
            return {
              url: location.href,
              hasTerminalError,
              hasPinInput,
              hasOtpInput,
              hasPayNowButton,
              hasContinueButton,
              otpInvalid,
              textPreview: text.slice(0, 240),
            };
          },
        });
        return (Array.isArray(results) ? results : [])
          .filter((item) => Number.isInteger(item?.frameId) && item.result)
          .map((item) => ({
            frameId: item.frameId,
            ...(item.result || {}),
          }));
      } catch (_) {
        return [];
      }
    }

    async function tabAnyFrameHasPayNowButton(tabId) {
      const inspections = await inspectGoPayFramesByDom(tabId);
      return (Array.isArray(inspections) ? inspections : []).some((item) => item?.hasPayNowButton);
    }

    function getGoPayDomFrameKind(frame = {}) {
      if (frame.otpInvalid) return 'otp';
      if (frame.hasPinInput) return 'pin';
      if (frame.hasOtpInput) return 'otp';
      if (frame.hasPayNowButton) return 'payment';
      if (frame.hasContinueButton) return 'payment';
      if (frame.hasTerminalError) return 'payment';
      return '';
    }

    function getGoPayDomFramePriority(frame = {}) {
      if (frame.hasTerminalError) return 120;
      if (frame.otpInvalid) return 115;
      if (frame.hasPinInput) return 110;
      if (frame.hasOtpInput) return 100;
      if (frame.hasPayNowButton) return 90;
      if (frame.hasContinueButton) return 80;
      return 0;
    }

    function isGoPayDebuggerTargetUrl(url = '') {
      const value = String(url || '');
      return isGoPayOtpFrameUrl(value)
        || isGoPayPinFrameUrl(value)
        || isGoPayPaymentFrameUrl(value)
        || /gopayapi\.com|app\.midtrans\.com\/snap/i.test(value);
    }

    function getGoPayDebuggerProbePriority(probe = {}) {
      const domPriority = getGoPayDomFramePriority(probe);
      const url = String(probe.url || '');
      const typeBonus = probe.type === 'iframe' ? 30 : 0;
      const urlBonus = isGoPayPinFrameUrl(url)
        ? 12
        : (isGoPayPaymentFrameUrl(url) ? 10 : (isGoPayOtpFrameUrl(url) ? 8 : 0));
      return domPriority + typeBonus + urlBonus;
    }

    async function getGoPayDebuggerTargets(tabId) {
      if (!chrome?.debugger?.getTargets) {
        return [];
      }
      const targets = await chrome.debugger.getTargets().catch(() => []);
      return (Array.isArray(targets) ? targets : [])
        .filter((target) => target?.id && isGoPayDebuggerTargetUrl(target.url || target.title || ''))
        .filter((target) => {
          if (!Number.isInteger(tabId) || !Number.isInteger(target.tabId)) {
            return true;
          }
          return target.tabId === tabId;
        });
    }

    function buildGoPayDebuggerStateExpression() {
      return `(() => {
        const normalize = (value = '') => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          let node = el;
          while (node && node.nodeType === 1) {
            if (node.hidden || node.getAttribute?.('aria-hidden') === 'true' || node.getAttribute?.('inert') !== null) {
              return false;
            }
            const nodeStyle = window.getComputedStyle?.(node);
            if (nodeStyle && (nodeStyle.display === 'none' || nodeStyle.visibility === 'hidden' || Number(nodeStyle.opacity) === 0)) {
              return false;
            }
            node = node.parentElement;
          }
          const rect = el.getBoundingClientRect?.();
          return Boolean(rect && rect.width > 0 && rect.height > 0);
        };
        const enabled = (el) => Boolean(el)
          && !el.disabled
          && el.getAttribute?.('aria-disabled') !== 'true';
        const getText = (el) => normalize([
          el?.textContent,
          el?.innerText,
          el?.value,
          el?.getAttribute?.('data-testid'),
          el?.getAttribute?.('aria-label'),
          el?.getAttribute?.('title'),
          el?.getAttribute?.('placeholder'),
          el?.getAttribute?.('name'),
          el?.id,
          typeof el?.className === 'string' ? el.className : el?.getAttribute?.('class'),
          el?.type,
          el?.inputMode,
        ].filter(Boolean).join(' '));
        const bodyText = normalize(document.body?.innerText || document.body?.textContent || '');
        const controls = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
          .filter((el) => visible(el) && enabled(el));
        const inputs = Array.from(document.querySelectorAll('input, textarea'))
          .filter((el) => visible(el) && enabled(el));
        const controlTexts = controls.map(getText);
        const inputHints = inputs.map(getText);
        const isPinPage = /pin|password|passcode|security|sandi|6\\s*digit|masukkin\\s+pin|masukkan\\s+pin|ketik\\s+6\\s+digit|enter\\s+pin|支付密码/i.test(bodyText)
          || /pin-web-client\\.gopayapi\\.com|\\/auth\\/pin|\\/payment\\/validate-pin|linking-validate-pin/i.test(location.href || '');
        const hasTerminalError = /waktunya\\s+habis|ulang(?:i)?\\s+prosesnya\\s+dari\\s+awal|time(?:'s|\\s+is)?\\s+(?:out|expired)|session\\s+expired|expired|kedaluwarsa|technical\\s+error|terjadi\\s+kesalahan|error\\s+teknis|kendala\\s+teknis|gak\\s+bisa\\s+diproses|coba\\s+lagi\\s+nanti|payment\\s+failed|pembayaran\\s+gagal|transaksi\\s+gagal|ditolak|declined|failed/i.test(bodyText);
        const otpInvalid = /kode\\s*otp(?:[-\\s]*nya)?\\s*salah|otp(?:\\s*(?:is|nya))?\\s*(?:salah|incorrect|invalid|wrong)|kode\\s*(?:salah|tidak\\s+valid)|mohon\\s+cek\\s+ulang|coba\\s+lagi/i.test(bodyText);
        const hasPinInput = isPinPage || inputHints.some((hint) => /pin-input|(?:^|[\\s_-])pin(?:$|[\\s_-])|password|numeric|支付密码/i.test(hint));
        const hasOtpInput = !hasPinInput && (/otp|one[-\\s]*time|kode|verification|whatsapp|验证码|短信/i.test(bodyText)
          || inputHints.some((hint) => /otp|code|kode|verification|whatsapp/i.test(hint)));
        const hasPhoneInput = !hasOtpInput && !hasPinInput && inputs.some((input) => {
          const hint = getText(input);
          const type = String(input.type || input.getAttribute?.('type') || '').toLowerCase();
          return type === 'tel'
            || /gopay|go\\s*pay|phone|mobile|whatsapp|wa|nomor|ponsel|telepon|hp|手机|手机号|电话号码|电话/i.test(hint);
        });
        const hasPayNowButton = controlTexts.some((item) => /^\\s*pay\\s+now\\s*$/i.test(item)
          || /^\\s*bayar(?:\\s+sekarang)?(?:\\s*rp[\\s\\S]*)?\\s*$/i.test(item)
          || /^\\s*bayar\\b[\\s\\S]*$/i.test(item)
          || /(?:^|\\s)pay-button(?:\\s|$)/i.test(item));
        const hasContinueButton = !hasPayNowButton && !hasPhoneInput && controlTexts.some((item) => /continue|next|submit|verify|confirm|authorize|allow|lanjut|lanjutkan|berikut|kirim|konfirmasi|hubungkan|sambungkan|tautkan|setuju|izinkan|link|继续|下一步|提交|验证|确认|授权|绑定|关联/i.test(item));
        const completed = /success|successful|completed|selesai|berhasil|approved|authorized|支付成功|绑定成功|已授权/i.test(bodyText)
          && !hasPhoneInput
          && !hasOtpInput
          && !hasPinInput
          && !hasPayNowButton;
        return {
          url: location.href,
          readyState: document.readyState,
          hasTerminalError,
          hasPhoneInput,
          hasPinInput,
          hasOtpInput,
          hasPayNowButton,
          hasContinueButton,
          otpInvalid,
          completed,
          textPreview: bodyText.slice(0, 500),
          inputHints: inputHints.slice(0, 12),
        };
      })()`;
    }

    function buildGoPayDebuggerClickPayExpression() {
      return `(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalize = (value = '') => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          let node = el;
          while (node && node.nodeType === 1) {
            if (node.hidden || node.getAttribute?.('aria-hidden') === 'true' || node.getAttribute?.('inert') !== null) {
              return false;
            }
            const nodeStyle = window.getComputedStyle?.(node);
            if (nodeStyle && (nodeStyle.display === 'none' || nodeStyle.visibility === 'hidden' || Number(nodeStyle.opacity) === 0)) {
              return false;
            }
            node = node.parentElement;
          }
          const rect = el.getBoundingClientRect?.();
          return Boolean(rect && rect.width > 0 && rect.height > 0);
        };
        const getText = (el) => normalize([
          el?.textContent,
          el?.innerText,
          el?.value,
          el?.getAttribute?.('data-testid'),
          el?.getAttribute?.('aria-label'),
          el?.getAttribute?.('title'),
          el?.id,
        ].filter(Boolean).join(' '));
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
          .filter((el) => visible(el) && !el.disabled && el.getAttribute?.('aria-disabled') !== 'true');
        const target = candidates.find((el) => {
          const text = getText(el);
          return /(?:^|\\s)pay-button(?:\\s|$)/i.test(text)
            || /^\\s*pay\\s+now\\s*$/i.test(text)
            || /^\\s*bayar(?:\\s+sekarang)?(?:\\s*rp[\\s\\S]*)?\\s*$/i.test(text)
            || /^\\s*bayar\\b[\\s\\S]*$/i.test(text);
        });
        if (!target) {
          return { clicked: false, reason: 'target_not_found', url: location.href, textPreview: normalize(document.body?.innerText || '').slice(0, 240) };
        }
        target.scrollIntoView?.({ block: 'center', inline: 'center' });
        await sleep(120);
        try { target.focus?.({ preventScroll: true }); } catch (_) { try { target.focus?.(); } catch (__) {} }
        const rect = target.getBoundingClientRect?.();
        const clientX = rect ? Math.round(rect.left + rect.width / 2) : 0;
        const clientY = rect ? Math.round(rect.top + rect.height / 2) : 0;
        const eventInit = { bubbles: true, cancelable: true, composed: true, view: window, detail: 1, clientX, clientY, button: 0, buttons: 1 };
        if (typeof PointerEvent === 'function') {
          target.dispatchEvent(new PointerEvent('pointerover', { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          target.dispatchEvent(new PointerEvent('pointermove', { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          target.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        }
        target.dispatchEvent(new MouseEvent('mouseover', eventInit));
        target.dispatchEvent(new MouseEvent('mousemove', eventInit));
        target.dispatchEvent(new MouseEvent('mousedown', eventInit));
        if (typeof PointerEvent === 'function') {
          target.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
        }
        target.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
        target.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 }));
        target.click?.();
        await sleep(500);
        return {
          clicked: true,
          url: location.href,
          target: \`\${String(target.tagName || '').toUpperCase()} \${getText(target)}\`.trim(),
          rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 } : null,
        };
      })()`;
    }

    function buildGoPayDebuggerClickContinueExpression() {
      return `(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalize = (value = '') => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect?.();
          const style = window.getComputedStyle?.(el);
          return Boolean(rect && rect.width > 0 && rect.height > 0)
            && (!style || (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0));
        };
        const getText = (el) => normalize([
          el?.textContent,
          el?.innerText,
          el?.value,
          el?.getAttribute?.('data-testid'),
          el?.getAttribute?.('aria-label'),
          el?.getAttribute?.('title'),
          el?.id,
        ].filter(Boolean).join(' '));
        const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
          .filter((el) => visible(el) && !el.disabled && el.getAttribute?.('aria-disabled') !== 'true');
        const target = candidates.find((el) => {
          const text = getText(el);
          if (/^\\s*pay\\s+now\\s*$/i.test(text) || /^\\s*bayar(?:\\s+sekarang)?(?:\\s*rp[\\s\\S]*)?\\s*$/i.test(text)) {
            return false;
          }
          return /continue|next|submit|verify|confirm|authorize|allow|lanjut|lanjutkan|berikut|kirim|konfirmasi|hubungkan|sambungkan|tautkan|setuju|izinkan|link|继续|下一步|提交|验证|确认|授权|绑定|关联/i.test(text);
        });
        if (!target) {
          return { clicked: false, reason: 'target_not_found', url: location.href, textPreview: normalize(document.body?.innerText || '').slice(0, 240) };
        }
        target.scrollIntoView?.({ block: 'center', inline: 'center' });
        await sleep(120);
        try { target.focus?.({ preventScroll: true }); } catch (_) { try { target.focus?.(); } catch (__) {} }
        const rect = target.getBoundingClientRect?.();
        const clientX = rect ? Math.round(rect.left + rect.width / 2) : 0;
        const clientY = rect ? Math.round(rect.top + rect.height / 2) : 0;
        const eventInit = { bubbles: true, cancelable: true, composed: true, view: window, detail: 1, clientX, clientY, button: 0, buttons: 1 };
        if (typeof PointerEvent === 'function') {
          target.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        }
        target.dispatchEvent(new MouseEvent('mousedown', eventInit));
        if (typeof PointerEvent === 'function') {
          target.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
        }
        target.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
        target.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 }));
        target.click?.();
        await sleep(500);
        return {
          clicked: true,
          url: location.href,
          target: \`\${String(target.tagName || '').toUpperCase()} \${getText(target)}\`.trim(),
        };
      })()`;
    }

    function buildGoPayDebuggerFocusPinExpression() {
      return `(() => {
        const visible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect?.();
          const style = window.getComputedStyle?.(el);
          return Boolean(rect && rect.width > 0 && rect.height > 0)
            && (!style || (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0));
        };
        const inputs = Array.from(document.querySelectorAll('input, textarea')).filter((el) => visible(el) && !el.disabled);
        const target = inputs.find((el) => /pin/i.test([
          el.getAttribute?.('data-testid'),
          el.getAttribute?.('aria-label'),
          el.getAttribute?.('placeholder'),
          el.getAttribute?.('name'),
          el.id,
          el.className,
          el.type,
          el.inputMode,
        ].filter(Boolean).join(' '))) || inputs.find((el) => String(el.type || '').toLowerCase() === 'password') || inputs[0];
        if (!target) {
          return { focused: false, reason: 'pin_input_not_found', textPreview: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240) };
        }
        target.scrollIntoView?.({ block: 'center', inline: 'center' });
        try { target.focus?.({ preventScroll: true }); } catch (_) { try { target.focus?.(); } catch (__) {} }
        target.click?.();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
          setter.call(target, '');
        } else {
          target.value = '';
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        const rect = target.getBoundingClientRect?.();
        return {
          focused: true,
          target: \`\${String(target.tagName || '').toUpperCase()} \${target.getAttribute?.('data-testid') || target.type || ''}\`.trim(),
          rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 } : null,
        };
      })()`;
    }

    function buildGoPayDebuggerFocusOtpExpression() {
      return `(() => {
        const normalize = (value = '') => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect?.();
          const style = window.getComputedStyle?.(el);
          return Boolean(rect && rect.width > 0 && rect.height > 0)
            && (!style || (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0));
        };
        const inputs = Array.from(document.querySelectorAll('input, textarea')).filter((el) => visible(el) && !el.disabled);
        const target = inputs.find((el) => /otp|one[-\\s]*time|kode|verification|whatsapp|code/i.test([
          el.getAttribute?.('data-testid'),
          el.getAttribute?.('aria-label'),
          el.getAttribute?.('placeholder'),
          el.getAttribute?.('name'),
          el.id,
          el.className,
          el.type,
          el.inputMode,
        ].filter(Boolean).join(' '))) || inputs[0];
        if (!target) {
          return { focused: false, reason: 'otp_input_not_found', textPreview: normalize(document.body?.innerText || '').slice(0, 240) };
        }
        target.scrollIntoView?.({ block: 'center', inline: 'center' });
        try { target.focus?.({ preventScroll: true }); } catch (_) { try { target.focus?.(); } catch (__) {} }
        target.click?.();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
          setter.call(target, '');
        } else {
          target.value = '';
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        const rect = target.getBoundingClientRect?.();
        return {
          focused: true,
          target: \`\${String(target.tagName || '').toUpperCase()} \${target.getAttribute?.('data-testid') || target.type || ''}\`.trim(),
          rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 } : null,
        };
      })()`;
    }

    async function withDebuggerTarget(targetId, callback) {
      if (!chrome?.debugger?.attach || !chrome?.debugger?.sendCommand || !targetId) {
        throw new Error('debugger_target_unavailable');
      }
      const target = { targetId };
      let attached = false;
      try {
        await chrome.debugger.attach(target, '1.3');
        attached = true;
      } catch (err) {
        throw new Error(`GoPay iframe 调试器附加失败：${err?.message || String(err || 'unknown_error')}`);
      }
      try {
        return await callback(target);
      } finally {
        if (attached) {
          await chrome.debugger.detach(target).catch(() => {});
        }
      }
    }

    async function evaluateGoPayDebuggerTarget(targetId, expression) {
      return withDebuggerTarget(targetId, async (debuggee) => {
        const result = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result?.exceptionDetails) {
          throw new Error(result.exceptionDetails?.text || 'GoPay iframe 脚本执行失败');
        }
        return result?.result?.value || {};
      });
    }

    async function typeDigitsWithDebugger(debuggee, digits, delayMs = 180) {
      for (const digit of String(digits || '').split('')) {
        throwIfStopped?.();
        await chrome.debugger.sendCommand(debuggee, 'Input.insertText', { text: digit });
        await sleepWithStop(delayMs);
      }
    }

    async function submitGoPayOtpWithDebuggerTarget(targetId, code = '') {
      const normalizedCode = normalizeGoPayOtp(code);
      if (!normalizedCode) {
        throw new Error('GoPay WhatsApp 验证码为空。');
      }
      return withDebuggerTarget(targetId, async (debuggee) => {
        const focused = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
          expression: buildGoPayDebuggerFocusOtpExpression(),
          returnByValue: true,
          awaitPromise: true,
        });
        const focusValue = focused?.result?.value || {};
        if (!focusValue.focused) {
          throw new Error(focusValue.reason || 'GoPay 验证码输入框未找到');
        }
        await sleepWithStop(200);
        await typeDigitsWithDebugger(debuggee, normalizedCode, 160);
        await sleepWithStop(500);
        const continueResult = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
          expression: buildGoPayDebuggerClickContinueExpression(),
          returnByValue: true,
          awaitPromise: true,
        }).catch(() => null);
        const continueValue = continueResult?.result?.value || {};
        return {
          otpSubmitted: true,
          clicked: Boolean(continueValue.clicked),
          clickTarget: continueValue.target || '',
          phase: 'otp_submitted_debugger_target',
          target: focusValue.target || '',
        };
      });
    }

    async function submitGoPayPinWithDebuggerTarget(targetId, pin = '') {
      const normalizedPin = normalizeGoPayOtp(pin);
      if (!normalizedPin) {
        throw new Error('GoPay PIN 为空，请先在侧边栏配置。');
      }
      return withDebuggerTarget(targetId, async (debuggee) => {
        const focused = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
          expression: buildGoPayDebuggerFocusPinExpression(),
          returnByValue: true,
          awaitPromise: true,
        });
        const focusValue = focused?.result?.value || {};
        if (!focusValue.focused) {
          throw new Error(focusValue.reason || 'GoPay PIN 输入框未找到');
        }
        await sleepWithStop(250);
        await typeDigitsWithDebugger(debuggee, normalizedPin, 220);
        await sleepWithStop(500);
        return {
          pinSubmitted: true,
          clicked: false,
          clickTarget: '',
          phase: 'pin_submitted_debugger_target',
          target: focusValue.target || '',
        };
      });
    }

    async function inspectGoPayDebuggerTargets(tabId) {
      const targets = await getGoPayDebuggerTargets(tabId);
      const probes = [];
      for (const target of targets) {
        try {
          const state = await evaluateGoPayDebuggerTarget(target.id, buildGoPayDebuggerStateExpression());
          const probe = {
            targetId: target.id,
            type: target.type || '',
            title: target.title || '',
            tabId: target.tabId,
            url: state.url || target.url || '',
            ...state,
          };
          if (getGoPayDebuggerProbePriority(probe) > 0) {
            probes.push(probe);
          }
        } catch (_) {
          // Ignore targets that are navigating or cannot be attached at the moment.
        }
      }
      return probes.sort((left, right) => getGoPayDebuggerProbePriority(right) - getGoPayDebuggerProbePriority(left));
    }

    async function sendGoPayDebuggerTargetCommand(targetId, type, payload = {}) {
      if (type === 'GOPAY_GET_STATE') {
        return evaluateGoPayDebuggerTarget(targetId, buildGoPayDebuggerStateExpression());
      }
      if (type === 'GOPAY_CLICK_PAY_NOW') {
        const result = await evaluateGoPayDebuggerTarget(targetId, buildGoPayDebuggerClickPayExpression());
        if (!result?.clicked) {
          return { clicked: false, clickTarget: '', reason: result?.reason || 'target_not_found' };
        }
        return {
          clicked: true,
          clickTarget: result.target || 'GoPay iframe Bayar',
          phase: 'pay_clicked_debugger_target',
        };
      }
      if (type === 'GOPAY_CLICK_CONTINUE') {
        const result = await evaluateGoPayDebuggerTarget(targetId, buildGoPayDebuggerClickContinueExpression());
        if (!result?.clicked) {
          return { clicked: false, clickTarget: '', reason: result?.reason || 'target_not_found' };
        }
        return {
          clicked: true,
          clickTarget: result.target || 'GoPay iframe continue',
          phase: 'continue_clicked_debugger_target',
        };
      }
      if (type === 'GOPAY_SUBMIT_OTP') {
        return submitGoPayOtpWithDebuggerTarget(targetId, payload.code || payload.otp || '');
      }
      if (type === 'GOPAY_SUBMIT_PIN') {
        return submitGoPayPinWithDebuggerTarget(targetId, payload.pin || payload.gopayPin || '');
      }
      throw new Error(`GoPay iframe 调试器暂不支持命令：${type}`);
    }

    async function findGoPayActionFrame(tabId) {
      const frames = await getTabFrames(tabId);
      const domFrames = (await inspectGoPayFramesByDom(tabId))
        .filter((item) => Number.isInteger(item.frameId) && item.frameId !== 0 && getGoPayDomFramePriority(item) > 0)
        .sort((left, right) => getGoPayDomFramePriority(right) - getGoPayDomFramePriority(left));
      if (domFrames.length) {
        const picked = domFrames[0];
        return {
          frameId: picked.frameId,
          kind: getGoPayDomFrameKind(picked),
          url: picked.url || frames.find((item) => item.frameId === picked.frameId)?.url || '',
        };
      }

      const debuggerFrames = (await inspectGoPayDebuggerTargets(tabId))
        .filter((target) => target.type === 'iframe');
      if (debuggerFrames.length) {
        const picked = debuggerFrames[0];
        return {
          frameId: null,
          targetId: picked.targetId,
          kind: getGoPayDomFrameKind(picked),
          url: picked.url || '',
          via: 'debugger-target',
        };
      }

      const pinFrame = frames.find((item) => isGoPayPinFrameUrl(item.url));
      if (pinFrame && Number.isInteger(pinFrame.frameId)) {
        return { frameId: pinFrame.frameId, kind: 'pin', url: pinFrame.url || '' };
      }
      const otpFrame = frames.find((item) => isGoPayOtpFrameUrl(item.url));
      if (otpFrame && Number.isInteger(otpFrame.frameId)) {
        return { frameId: otpFrame.frameId, kind: 'otp', url: otpFrame.url || '' };
      }

      const paymentFrames = frames
        .filter((item) => Number.isInteger(item.frameId) && item.frameId !== 0 && isGoPayPaymentFrameUrl(item.url));
      for (const frame of paymentFrames) {
        const ready = await ensureGoPayOtpFrameReady(tabId, frame.frameId);
        if (!ready) continue;
        try {
          const frameState = await sendGoPayFrameCommand(tabId, frame.frameId, 'GOPAY_GET_STATE', {});
          if (frameState?.hasPayNowButton || frameState?.hasPinInput || frameState?.hasOtpInput || frameState?.hasContinueButton || frameState?.hasTerminalError) {
            return { frameId: frame.frameId, kind: getGoPayDomFrameKind(frameState) || 'payment', url: frame.url || '' };
          }
        } catch (_) {
          // Keep scanning; frame may still be navigating.
        }
      }

      return { frameId: null, kind: '', url: '' };
    }

    async function sendGoPayFrameCommand(tabId, frameId, type, payload = {}) {
      const result = await chrome.tabs.sendMessage(tabId, {
        type,
        source: 'background',
        payload,
      }, { frameId });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function pingGoPayFrame(tabId, frameId) {
      try {
        const pong = await chrome.tabs.sendMessage(tabId, {
          type: 'PING',
          source: 'background',
          payload: {},
        }, { frameId });
        return Boolean(pong?.ok && (!pong.source || pong.source === GOPAY_OTP_SOURCE || pong.source === GOPAY_SOURCE));
      } catch (_) {
        return false;
      }
    }

    async function ensureGoPayOtpFrameReady(tabId, frameId) {
      if (!Number.isInteger(frameId)) {
        return false;
      }
      if (await pingGoPayFrame(tabId, frameId)) {
        return true;
      }
      if (!chrome?.scripting?.executeScript) {
        return false;
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          func: (injectedSource) => {
            window.__MULTIPAGE_SOURCE = injectedSource;
          },
          args: [GOPAY_OTP_SOURCE],
        });
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          files: GOPAY_INJECT_FILES,
        });
      } catch (_) {
        // The frame may navigate during injection; the caller will retry on the next loop.
      }
      await sleepWithStop(300);
      return await pingGoPayFrame(tabId, frameId);
    }

    async function getGoPayState(tabId) {
      const result = await sendTabMessageUntilStopped(tabId, GOPAY_SOURCE, {
        type: 'GOPAY_GET_STATE',
        source: 'background',
        payload: {},
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function sendGoPayCommand(tabId, type, payload = {}) {
      const result = await sendTabMessageUntilStopped(tabId, GOPAY_SOURCE, {
        type,
        source: 'background',
        payload,
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function clickGoPayTargetWithDebugger(tabId, targetMessageType = 'GOPAY_GET_CONTINUE_TARGET', frameId = null) {
      if (typeof clickWithDebugger !== 'function') {
        return { clicked: false, reason: 'debugger_click_unavailable' };
      }
      const target = Number.isInteger(frameId)
        ? await sendGoPayFrameCommand(tabId, frameId, targetMessageType, {})
        : await sendGoPayCommand(tabId, targetMessageType, {});
      const rect = target?.rect || null;
      if (!target?.found || !rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
        return { clicked: false, reason: 'target_not_found', clickTarget: target?.target || '' };
      }
      if (Number.isInteger(frameId)) {
        return { clicked: false, reason: 'debugger_click_skipped_for_frame_target', clickTarget: target.target || '' };
      }
      await clickWithDebugger(tabId, rect);
      return { clicked: true, clickTarget: target.target || '' };
    }


    async function clickGoPayContinueWithDebugger(tabId, frameId = null) {
      return clickGoPayTargetWithDebugger(tabId, 'GOPAY_GET_CONTINUE_TARGET', frameId);
    }

    async function clickGoPayPayNowWithDebugger(tabId, frameId = null) {
      return clickGoPayTargetWithDebugger(tabId, 'GOPAY_GET_PAY_NOW_TARGET', frameId);
    }

    async function clickGoPayPayButtonInAnyFrame(tabId) {
      if (!chrome?.scripting?.executeScript) {
        return { clicked: false, reason: 'scripting_unavailable' };
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => {
            const normalize = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
            const isVisible = (el) => {
              if (!el) return false;
              let node = el;
              while (node && node.nodeType === 1) {
                if (node.hidden || node.getAttribute?.('aria-hidden') === 'true' || node.getAttribute?.('inert') !== null) {
                  return false;
                }
                const nodeStyle = window.getComputedStyle?.(node);
                if (nodeStyle && (nodeStyle.display === 'none' || nodeStyle.visibility === 'hidden' || Number(nodeStyle.opacity) === 0)) {
                  return false;
                }
                node = node.parentElement;
              }
              const rect = el.getBoundingClientRect?.();
              return Boolean(rect && rect.width > 0 && rect.height > 0);
            };
            const getText = (el) => normalize([
              el?.textContent,
              el?.value,
              el?.getAttribute?.('data-testid'),
              el?.getAttribute?.('aria-label'),
              el?.getAttribute?.('title'),
              el?.id,
            ].filter(Boolean).join(' '));
            const candidates = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
              .filter((el) => isVisible(el) && !el.disabled && el.getAttribute?.('aria-disabled') !== 'true');
            const target = candidates.find((el) => {
              const text = getText(el);
              return /(?:^|\s)pay-button(?:\s|$)/i.test(text)
                || /^\s*bayar(?:\s+sekarang)?(?:\s*rp[\s\S]*)?\s*$/i.test(text)
                || /^\s*bayar\b[\s\S]*$/i.test(text);
            });
            if (!target) {
              return { clicked: false, url: location.href };
            }
            target.scrollIntoView?.({ block: 'center', inline: 'center' });
            try { target.focus?.(); } catch (_) {}
            const rect = target.getBoundingClientRect?.();
            const clientX = rect ? Math.round(rect.left + rect.width / 2) : 0;
            const clientY = rect ? Math.round(rect.top + rect.height / 2) : 0;
            const eventInit = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY, button: 0, buttons: 1 };
            if (typeof PointerEvent === 'function') {
              target.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
            }
            target.dispatchEvent(new MouseEvent('mousedown', eventInit));
            if (typeof PointerEvent === 'function') {
              target.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
            }
            target.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
            target.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 }));
            target.click?.();
            return {
              clicked: true,
              url: location.href,
              target: `${String(target.tagName || '').toUpperCase()} ${getText(target)}`.trim(),
            };
          },
        });
        const clicked = (Array.isArray(results) ? results : []).find((item) => item?.result?.clicked);
        if (clicked?.result?.clicked) {
          return {
            clicked: true,
            frameId: clicked.frameId,
            url: clicked.result.url || '',
            clickTarget: clicked.result.target || '',
          };
        }
      } catch (error) {
        return { clicked: false, reason: error?.message || String(error || 'unknown_error') };
      }
      return { clicked: false, reason: 'target_not_found' };
    }

    async function waitForGoPayState(tabId, predicate, options = {}) {
      const timeoutMs = Math.max(0, Math.floor(Number(options.timeoutMs) || GOPAY_WAIT_TIMEOUT_MS));
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          throw new Error(`${stepLabel}：GoPay 标签页已关闭，无法继续。`);
        }
        const url = String(tab.url || '');
        if (isReturnUrl(url)) {
          return { returned: true, url };
        }
        await ensureGoPayReady(tabId, `${stepLabel}：GoPay 页面正在切换，等待脚本重新就绪...`);
        const actionFrame = await findGoPayActionFrame(tabId);
        const actionFrameId = actionFrame.frameId;
        const actionTargetId = actionFrame.targetId;
        if (Number.isInteger(actionFrameId)) {
          await ensureGoPayOtpFrameReady(tabId, actionFrameId);
        }
        const pageState = actionTargetId
          ? await sendGoPayDebuggerTargetCommand(actionTargetId, 'GOPAY_GET_STATE', {})
          : (Number.isInteger(actionFrameId)
            ? await sendGoPayFrameCommand(tabId, actionFrameId, 'GOPAY_GET_STATE', {})
            : await getGoPayState(tabId));
        if (predicate(pageState, tab)) {
          return { pageState, tab };
        }
        await sleepWithStop(GOPAY_POLL_INTERVAL_MS);
      }
      return { timeout: true };
    }

    async function clickGoPayContinueBestEffort(tabId) {
      const actionFrame = await findGoPayActionFrame(tabId);
      const actionFrameId = actionFrame.frameId;
      const actionTargetId = actionFrame.targetId;
      if (Number.isInteger(actionFrameId)) {
        await ensureGoPayOtpFrameReady(tabId, actionFrameId);
      }

      try {
        if (actionTargetId) {
          const result = await sendGoPayDebuggerTargetCommand(actionTargetId, 'GOPAY_CLICK_CONTINUE', {});
          if (result?.clicked) {
            return result;
          }
        } else if (Number.isInteger(actionFrameId)) {
          const result = await sendGoPayFrameCommand(tabId, actionFrameId, 'GOPAY_CLICK_CONTINUE', {});
          if (result?.clicked) {
            return result;
          }
        } else {
          const result = await sendGoPayCommand(tabId, 'GOPAY_CLICK_CONTINUE', {});
          if (result?.clicked) {
            return result;
          }
        }
      } catch (_) {
        // Fall through to a real debugger click below.
      }

      return clickGoPayContinueWithDebugger(tabId, actionFrameId);
    }

    function normalizeGoPayCountryCode(value = '') {
      const normalized = String(value || '').trim().replace(/[^\d+]/g, '');
      const digits = normalized.replace(/\D/g, '');
      return digits ? `+${digits}` : '+86';
    }

    function normalizeGoPayOtp(value = '') {
      return String(value || '').trim().replace(/[^\d]/g, '');
    }

    function resolveGoPayCredentials(state = {}) {
      return {
        countryCode: normalizeGoPayCountryCode(state.gopayCountryCode || '+86'),
        phone: normalizeText(state.gopayPhone || ''),
        otp: normalizeGoPayOtp(state.gopayOtp || ''),
        pin: String(state.gopayPin || ''),
      };
    }

    async function fetchGoPayOtpFromApi(state = {}) {
      if (!gopayOtpClient || typeof gopayOtpClient.pollOtp !== 'function') {
        throw new Error(`${stepLabel}：未初始化 WhatsApp OTP 客户端，无法自动拉取 GoPay 验证码。`);
      }
      const code = await gopayOtpClient.pollOtp(state, {
        intervalMs: 3000,
        timeoutMs: 180000,
        label: 'GoPay 验证码',
        stepLabel,
      });
      const normalized = normalizeGoPayOtp(code);
      if (!normalized) {
        throw new Error(`${stepLabel}：WhatsApp 接口返回的 GoPay 验证码为空。`);
      }
      return normalized;
    }

    async function executeGoPayApprove(state = {}, options = {}) {
      const requestedStepId = Number(options?.stepId);
      stepId = Number.isFinite(requestedStepId) && requestedStepId > 0 ? requestedStepId : 8;
      stepLabel = `步骤 ${stepId}`;

      const credentials = resolveGoPayCredentials(state);
      if (!credentials.phone) {
        throw new Error(`${stepLabel}：未配置 GoPay 手机号，请先在侧边栏填写。`);
      }
      if (!credentials.pin) {
        throw new Error(`${stepLabel}：未配置 GoPay PIN，请先在侧边栏填写。`);
      }

      const tabId = await resolveGoPayTabId(state);
      await ensureGoPayReady(tabId);
      await setState({ plusCheckoutTabId: tabId });

      function resetTransientStepFlags() {
        otpSubmitted = false;
        pinSubmitted = false;
        continueClickAttempts = 0;
        lastContinueClickSignature = '';
        payNowClickAttempts = 0;
        lastPayNowClickSignature = '';
        stableStateTracker?.reset?.();
      }

      let phoneSubmitted = false;
      let otpSubmitted = false;
      let pinSubmitted = false;
      let loggedWaiting = false;
      let continueClickAttempts = 0;
      let lastContinueClickSignature = '';
      let payNowClickAttempts = 0;
      let lastPayNowClickSignature = '';
      let technicalErrorRefreshAttempts = 0;
      const stableStateTracker = createGoPayStableStateTracker();

      while (true) {
        throwIfStopped?.();
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const currentUrl = String(tab?.url || '');
        if (currentUrl && isReturnUrl(currentUrl)) {
          await addLog(`${stepLabel}：GoPay 已跳转回 ChatGPT / OpenAI 页面，准备进入回跳确认。`, 'ok');
          break;
        }

        await ensureGoPayReady(tabId, `${stepLabel}：GoPay 页面正在切换，等待脚本重新就绪...`);
        const actionFrame = await findGoPayActionFrame(tabId);
        const actionFrameId = actionFrame.frameId;
        const actionTargetId = actionFrame.targetId;
        if (Number.isInteger(actionFrameId)) {
          await ensureGoPayOtpFrameReady(tabId, actionFrameId);
        }
        const pageState = actionTargetId
          ? await sendGoPayDebuggerTargetCommand(actionTargetId, 'GOPAY_GET_STATE', {})
          : (Number.isInteger(actionFrameId)
            ? await sendGoPayFrameCommand(tabId, actionFrameId, 'GOPAY_GET_STATE', {})
            : await getGoPayState(tabId));
        const stableState = stableStateTracker.update(pageState, currentUrl);
        if (String(pageState?.terminalError?.code || '').trim().toLowerCase() === 'technical-error') {
          technicalErrorRefreshAttempts += 1;
        } else {
          technicalErrorRefreshAttempts = 0;
        }
        const terminalResolution = await handleGoPayTerminalError(pageState, tabId, {
          technicalErrorRefreshAttempts,
          flowState: state,
        });
        if (terminalResolution?.reloaded) {
          resetTransientStepFlags();
          loggedWaiting = false;
          continue;
        }

        if (pageState.completed) {
          if (isMidtransCheckoutUrl(currentUrl) && await tabAnyFrameHasPayNowButton(tabId)) {
            await addLog(
              `${stepLabel}：Midtrans 仍能在子 frame 检测到 Pay now，忽略「完成」文案，继续尝试支付。`,
              'info'
            );
            loggedWaiting = false;
            await sleepWithStop(GOPAY_POLL_INTERVAL_MS);
            continue;
          }
          await addLog(`${stepLabel}：GoPay 页面已显示完成状态，准备进入回跳确认。`, 'ok');
          break;
        }

        if (pageState.hasPayNowButton) {
          const payNowSignature = `${actionFrame.kind || 'top'}::${pageState.url || currentUrl || ''}::${pageState.textPreview || ''}`.slice(0, 700);
          if (payNowSignature === lastPayNowClickSignature) {
            payNowClickAttempts += 1;
          } else {
            lastPayNowClickSignature = payNowSignature;
            payNowClickAttempts = 1;
          }
          if (!Number.isInteger(actionFrameId) && payNowClickAttempts > 2) {
            const framePayResult = await clickGoPayPayButtonInAnyFrame(tabId);
            if (framePayResult?.clicked) {
              await addLog(`${stepLabel}：顶层仍显示 Pay now，但已在 GoPay iframe 中点击 Bayar 按钮：${framePayResult.clickTarget || 'Bayar'}。`, 'info');
              await sleepWithStop(2500);
              resetTransientStepFlags();
              loggedWaiting = false;
              continue;
            }
            await addLog(`${stepLabel}：顶层 Pay now 已重复出现，暂未识别到 iframe 内 Bayar/PIN；继续等待页面切换，不再自动回退步骤 6。`, 'warn');
            await sleepWithStop(3000);
            loggedWaiting = false;
            continue;
          }
          const paymentLabel = actionFrame.kind === 'payment' ? '最终 Bayar 确认' : 'Pay now';
          await addLog(`${stepLabel}：检测到 GoPay ${paymentLabel} 按钮，正在点击完成支付...`, 'info');
          const payResult = actionTargetId
            ? await sendGoPayDebuggerTargetCommand(actionTargetId, 'GOPAY_CLICK_PAY_NOW', {})
            : (Number.isInteger(actionFrameId)
              ? await sendGoPayFrameCommand(tabId, actionFrameId, 'GOPAY_CLICK_PAY_NOW', {})
              : await sendGoPayCommand(tabId, 'GOPAY_CLICK_PAY_NOW', {}));
          if (payResult?.clickTarget) {
            await addLog(`${stepLabel}：已点击 GoPay 支付按钮：${payResult.clickTarget}`, 'info');
          }
          await sleepWithStop(2500);
          const decision = await waitForGoPayState(tabId, (nextState) => (
            nextState.hasTerminalError
            || nextState.completed
            || !nextState.hasPayNowButton
          ), { timeoutMs: 15000 });
          if (String(decision.pageState?.terminalError?.code || '').trim().toLowerCase() === 'technical-error') {
            technicalErrorRefreshAttempts += 1;
          } else if (decision.pageState) {
            technicalErrorRefreshAttempts = 0;
          }
          const payTerminalResolution = await handleGoPayTerminalError(decision.pageState, tabId, {
            technicalErrorRefreshAttempts,
            flowState: state,
          });
          if (payTerminalResolution?.reloaded) {
            resetTransientStepFlags();
            loggedWaiting = false;
            continue;
          }
          if (decision.returned) {
            await addLog(`${stepLabel}：GoPay 支付后已跳转回 ChatGPT / OpenAI 页面，准备进入回跳确认。`, 'ok');
            break;
          }
          if (decision.pageState) {
            resetTransientStepFlags();
          }
          if (decision.timeout) {
            const framePayResult = await clickGoPayPayButtonInAnyFrame(tabId);
            if (framePayResult?.clicked) {
              await addLog(`${stepLabel}：已在 GoPay iframe 中点击 Bayar 按钮：${framePayResult.clickTarget || 'Bayar'}。`, 'info');
              await sleepWithStop(2500);
              resetTransientStepFlags();
              loggedWaiting = false;
              continue;
            }
            const debuggerResult = await clickGoPayPayNowWithDebugger(tabId, actionFrameId);
            if (debuggerResult?.clickTarget) {
              await addLog(`${stepLabel}：已使用 debugger 点击 GoPay 支付按钮：${debuggerResult.clickTarget}`, 'info');
            }
            await sleepWithStop(2500);
            const lateFramePayResult = await clickGoPayPayButtonInAnyFrame(tabId);
            if (lateFramePayResult?.clicked) {
              await addLog(`${stepLabel}：Pay now 兜底点击后，已在 GoPay iframe 中补点 Bayar 按钮：${lateFramePayResult.clickTarget || 'Bayar'}。`, 'info');
              await sleepWithStop(2500);
              resetTransientStepFlags();
              loggedWaiting = false;
              continue;
            }
            await addLog(`${stepLabel}：Pay now 兜底点击后仍未识别到 iframe 内 Bayar/PIN，继续等待，不自动回退步骤 6。`, 'warn');
          }
          resetTransientStepFlags();
          loggedWaiting = false;
          continue;
        }

        if (pageState.hasPhoneInput && !phoneSubmitted) {
          await addLog(`${stepLabel}：正在切换 GoPay 区号 ${credentials.countryCode} 并填写手机号...`, 'info');
          await sendGoPayCommand(tabId, 'GOPAY_SUBMIT_PHONE', {
            countryCode: credentials.countryCode,
            phone: credentials.phone,
          });
          phoneSubmitted = true;
          continueClickAttempts = 0;
          lastContinueClickSignature = '';
          loggedWaiting = false;
          await sleepWithStop(1500);
          continue;
        }

        if (pageState.hasPinInput && !pinSubmitted) {
          await addLog(`${stepLabel}：正在填写 GoPay PIN...`, 'info');
          if (actionTargetId) {
            await sendGoPayDebuggerTargetCommand(actionTargetId, 'GOPAY_SUBMIT_PIN', { pin: credentials.pin });
          } else if (Number.isInteger(actionFrameId)) {
            await ensureGoPayOtpFrameReady(tabId, actionFrameId);
            await sendGoPayFrameCommand(tabId, actionFrameId, 'GOPAY_SUBMIT_PIN', { pin: credentials.pin });
          } else {
            await sendGoPayCommand(tabId, 'GOPAY_SUBMIT_PIN', { pin: credentials.pin });
          }
          pinSubmitted = true;
          continueClickAttempts = 0;
          lastContinueClickSignature = '';
          loggedWaiting = false;
          const afterPinDecision = await waitForGoPayState(tabId, (nextState) => (
            nextState.hasTerminalError
            || nextState.hasPayNowButton
            || nextState.completed
          ), { timeoutMs: 20000 });
          if (String(afterPinDecision.pageState?.terminalError?.code || '').trim().toLowerCase() === 'technical-error') {
            technicalErrorRefreshAttempts += 1;
          } else if (afterPinDecision.pageState) {
            technicalErrorRefreshAttempts = 0;
          }
          const pinTerminalResolution = await handleGoPayTerminalError(afterPinDecision.pageState, tabId, {
            technicalErrorRefreshAttempts,
            flowState: state,
          });
          if (pinTerminalResolution?.reloaded) {
            resetTransientStepFlags();
            loggedWaiting = false;
            continue;
          }
          if (afterPinDecision.returned) {
            await addLog(`${stepLabel}：GoPay PIN 后已跳转回 ChatGPT / OpenAI 页面，准备进入回跳确认。`, 'ok');
            break;
          }
          if (afterPinDecision.pageState?.hasPayNowButton) {
            await addLog(`${stepLabel}：GoPay PIN 已通过，等待点击 Pay now 完成支付。`, 'info');
            resetTransientStepFlags();
          }
          await sleepWithStop(800);
          continue;
        }

        if (pageState.otpInvalid) {
          await addLog(`${stepLabel}：GoPay 提示验证码错误，准备重新读取 WhatsApp 验证码。`, 'warn');
          otpSubmitted = false;
          credentials.otp = '';
          continueClickAttempts = 0;
          lastContinueClickSignature = '';
          loggedWaiting = false;
          await sleepWithStop(1000);
          if (!pageState.hasOtpInput || pageState.hasPinInput) {
            continue;
          }
        }

        if (pageState.hasOtpInput && !pageState.hasPinInput && !otpSubmitted) {
          const code = await fetchGoPayOtpFromApi(state);
          credentials.otp = code;
          await addLog(`${stepLabel}：正在填写 GoPay 验证码...`, 'info');
          if (actionTargetId) {
            await sendGoPayDebuggerTargetCommand(actionTargetId, 'GOPAY_SUBMIT_OTP', { code });
          } else if (Number.isInteger(actionFrameId)) {
            await ensureGoPayOtpFrameReady(tabId, actionFrameId);
            await sendGoPayFrameCommand(tabId, actionFrameId, 'GOPAY_SUBMIT_OTP', { code });
          } else {
            await ensureGoPayReady(tabId, `${stepLabel}：已获取 GoPay 验证码，等待 GoPay 页面就绪...`);
            await sendGoPayCommand(tabId, 'GOPAY_SUBMIT_OTP', { code });
          }
          otpSubmitted = true;
          continueClickAttempts = 0;
          lastContinueClickSignature = '';
          loggedWaiting = false;
          await sleepWithStop(1500);
          continue;
        }

        if (pageState.hasContinueButton) {
          const continueSignature = `${pageState.url || currentUrl || ''}::${pageState.textPreview || ''}`.slice(0, 700);
          if (continueSignature === lastContinueClickSignature) {
            continueClickAttempts += 1;
          } else {
            lastContinueClickSignature = continueSignature;
            continueClickAttempts = 1;
          }
          if (continueClickAttempts > 2) {
            const stableBeforeRetrySeconds = Math.round(stableState.stableMs / 1000);
            await addLog(`${stepLabel}：GoPay 确认按钮点击后页面仍未变化，先等待 linking 页面加载/跳转（已稳定 ${stableBeforeRetrySeconds}s）。`, 'warn');
            const decision = await waitForGoPayState(tabId, (nextState) => (
              nextState.hasTerminalError
              || nextState.otpInvalid
              || nextState.hasOtpInput
              || nextState.hasPinInput
              || nextState.hasPayNowButton
              || nextState.completed
              || !nextState.hasContinueButton
            ), { timeoutMs: GOPAY_LINKING_RETRY_WAIT_MS });
            if (String(decision.pageState?.terminalError?.code || '').trim().toLowerCase() === 'technical-error') {
              technicalErrorRefreshAttempts += 1;
            } else if (decision.pageState) {
              technicalErrorRefreshAttempts = 0;
            }
            const continueTerminalResolution = await handleGoPayTerminalError(decision.pageState, tabId, {
              technicalErrorRefreshAttempts,
              flowState: state,
            });
            if (continueTerminalResolution?.reloaded) {
              resetTransientStepFlags();
              loggedWaiting = false;
              continue;
            }
            if (decision.returned) {
              await addLog(`${stepLabel}：GoPay 已跳转回 ChatGPT / OpenAI 页面，准备进入回跳确认。`, 'ok');
              break;
            }
            if (!decision.timeout) {
              continueClickAttempts = 0;
              lastContinueClickSignature = '';
              stableStateTracker.reset();
              loggedWaiting = false;
              continue;
            }
            const refreshedState = decision.pageState || pageState;
            const refreshedStableState = stableStateTracker.update(refreshedState, currentUrl);
            const stableSeconds = Math.round(refreshedStableState.stableMs / 1000);
            if (stableSeconds < Math.round(GOPAY_LINKING_STABLE_WAIT_MS / 1000)) {
              await addLog(`${stepLabel}：GoPay linking 页面还在同一状态（${stableSeconds}s），改用兜底点击 Hubungkan/确认按钮后继续等待。`, 'info');
              const retryResult = await clickGoPayContinueBestEffort(tabId);
              if (retryResult?.clickTarget) {
                await addLog(`${stepLabel}：已兜底点击 GoPay 控件：${retryResult.clickTarget}`, 'info');
              }
              continueClickAttempts = 2;
              await sleepWithStop(2500);
              loggedWaiting = false;
              continue;
            }
            await addLog(`${stepLabel}：GoPay linking 页面长时间没有变化，已暂停自动重复点击。请手动点击页面上的 Hubungkan/确认按钮，插件会继续等待后续页面。`, 'warn');
            const manualDecision = await waitForGoPayState(tabId, (nextState) => (
              nextState.hasTerminalError
              || nextState.otpInvalid
              || nextState.hasOtpInput
              || nextState.hasPinInput
              || nextState.hasPayNowButton
              || nextState.completed
              || !nextState.hasContinueButton
            ), { timeoutMs: GOPAY_WAIT_TIMEOUT_MS });
            if (String(manualDecision.pageState?.terminalError?.code || '').trim().toLowerCase() === 'technical-error') {
              technicalErrorRefreshAttempts += 1;
            } else if (manualDecision.pageState) {
              technicalErrorRefreshAttempts = 0;
            }
            const manualTerminalResolution = await handleGoPayTerminalError(manualDecision.pageState, tabId, {
              technicalErrorRefreshAttempts,
              flowState: state,
            });
            if (manualTerminalResolution?.reloaded) {
              resetTransientStepFlags();
              loggedWaiting = false;
              continue;
            }
            if (manualDecision.returned) {
              await addLog(`${stepLabel}：GoPay 已跳转回 ChatGPT / OpenAI 页面，准备进入回跳确认。`, 'ok');
              break;
            }
            if (!manualDecision.timeout) {
              continueClickAttempts = 0;
              lastContinueClickSignature = '';
              stableStateTracker.reset();
              loggedWaiting = false;
              continue;
            }
            throw new Error(`${stepLabel}：GoPay linking 页面长时间无变化，请手动点击 Hubungkan/确认按钮后重新执行或继续当前步骤。`);
          }
          await addLog(`${stepLabel}：检测到 GoPay 继续/确认按钮，正在点击${continueClickAttempts > 1 ? `（第 ${continueClickAttempts} 次）` : ''}...`, 'info');
          const clickResult = continueClickAttempts === 1
            ? (actionTargetId
              ? await sendGoPayDebuggerTargetCommand(actionTargetId, 'GOPAY_CLICK_CONTINUE', {})
              : (Number.isInteger(actionFrameId)
                ? await sendGoPayFrameCommand(tabId, actionFrameId, 'GOPAY_CLICK_CONTINUE', {})
                : await sendGoPayCommand(tabId, 'GOPAY_CLICK_CONTINUE', {})))
            : await clickGoPayContinueWithDebugger(tabId, actionFrameId);
          if (clickResult?.clickTarget) {
            await addLog(`${stepLabel}：已点击 GoPay 控件：${clickResult.clickTarget}${continueClickAttempts > 1 ? '（debugger 真实鼠标事件）' : ''}`, 'info');
          }
          await sleepWithStop(2000);
          loggedWaiting = false;
          continue;
        }

        if (!loggedWaiting) {
          loggedWaiting = true;
          await addLog(`${stepLabel}：等待 GoPay 手机号、验证码、PIN 或完成页面出现...`, 'info');
        }

        const decision = await waitForGoPayState(tabId, (nextState) => (
          nextState.hasTerminalError
          || nextState.otpInvalid
          || nextState.hasPhoneInput
          || nextState.hasOtpInput
          || nextState.hasPinInput
          || nextState.hasContinueButton
          || nextState.hasPayNowButton
          || nextState.completed
        ), { timeoutMs: 10000 });
        if (String(decision.pageState?.terminalError?.code || '').trim().toLowerCase() === 'technical-error') {
          technicalErrorRefreshAttempts += 1;
        } else if (decision.pageState) {
          technicalErrorRefreshAttempts = 0;
        }
        const waitingTerminalResolution = await handleGoPayTerminalError(decision.pageState, tabId, {
          technicalErrorRefreshAttempts,
          flowState: state,
        });
        if (waitingTerminalResolution?.reloaded) {
          resetTransientStepFlags();
          loggedWaiting = false;
          continue;
        }
        if (decision.returned) {
          await addLog(`${stepLabel}：GoPay 已跳转回 ChatGPT / OpenAI 页面，准备进入回跳确认。`, 'ok');
          break;
        }
        if (decision.timeout) {
          await sleepWithStop(GOPAY_POLL_INTERVAL_MS);
        }
      }

      await setState({ plusGoPayApprovedAt: Date.now() });
      await completeStepFromBackground(stepId, {
        plusGoPayApprovedAt: Date.now(),
      });
    }

    return {
      executeGoPayApprove,
    };
  }

  return {
    createGoPayApproveExecutor,
  };
});
