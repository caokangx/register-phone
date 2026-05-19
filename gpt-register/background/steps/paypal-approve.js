(function attachBackgroundPayPalApprove(root, factory) {
  root.MultiPageBackgroundPayPalApprove = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPayPalApproveModule() {
  const PAYPAL_SOURCE = 'paypal-flow';
  const PLUS_CHECKOUT_SOURCE = 'plus-checkout';
  const PAYPAL_INJECT_FILES = ['content/utils.js', 'content/operation-delay.js', 'content/paypal-flow.js'];
  const PAYPAL_GUEST_PAGE_TIMEOUT_MS = 60000;
  const PAYPAL_GUEST_PAGE_POLL_MS = 500;
  const PAYPAL_SMS_PAGE_TIMEOUT_MS = 90000;
  const PAYPAL_CONSENT_PAGE_TIMEOUT_MS = 120000;
  const PAYPAL_CONSENT_PAGE_POLL_MS = 500;

  function createPayPalApproveExecutor(deps = {}) {
    const {
      addLog,
      chrome,
      completeNodeFromBackground,
      ensureContentScriptReadyOnTabUntilStopped,
      getTabId,
      isTabAlive,
      queryTabsInAutomationWindow = null,
      sendTabMessageUntilStopped,
      setState,
      sleepWithStop,
      throwIfStopped = () => {},
      waitForTabCompleteUntilStopped,
      waitForTabUrlMatchUntilStopped,
    } = deps;

    function isPayPalUrl(url = '') {
      return /^https?:\/\/[^/]*paypal\.com\//i.test(String(url || ''));
    }

    function isPayPalGuestLoginUrl(url = '') {
      try {
        const u = new URL(String(url || ''));
        if (!/paypal\.com$/i.test(u.hostname)) {
          return false;
        }
        const path = u.pathname;
        // /pay — classic guest login page.
        // /agreements/approve — Billing Agreement landing page (ba_token=...);
        //   shows the same "enter your email" prompt before redirecting onto
        //   /checkoutweb for guest card entry, so the same email-fill handler
        //   covers both.
        return path === '/pay'
          || path.endsWith('/pay')
          || /\/agreements\/approve\b/i.test(path);
      } catch {
        return false;
      }
    }

    function isPayPalGuestCheckoutUrl(url = '') {
      return /\/checkoutweb\//i.test(String(url || ''));
    }

    function isRetryablePayPalTransportError(error) {
      const message = String(typeof error === 'string' ? error : error?.message || '');
      return /back\/forward cache|message channel is closed|Receiving end does not exist|port closed before a response was received|A listener indicated an asynchronous response|内容脚本\s+\d+(?:\.\d+)?\s*秒内未响应|did not respond in \d+s/i.test(message);
    }

    async function findOpenPayPalTabId() {
      if (!chrome?.tabs?.query) {
        return 0;
      }
      const queryTabs = typeof queryTabsInAutomationWindow === 'function'
        ? queryTabsInAutomationWindow
        : (queryInfo) => chrome.tabs.query(queryInfo);
      const tabs = await queryTabs({}).catch(() => []);
      const candidates = (Array.isArray(tabs) ? tabs : [])
        .filter((tab) => Number.isInteger(tab?.id) && isPayPalUrl(tab.url || ''));
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

    async function resolvePayPalTabId(state = {}) {
      const paypalTabId = await getTabId(PAYPAL_SOURCE);
      if (paypalTabId && await isTabAlive(PAYPAL_SOURCE)) {
        return paypalTabId;
      }
      const discoveredPayPalTabId = await findOpenPayPalTabId();
      if (discoveredPayPalTabId) {
        await addLog('步骤 8：已从当前浏览器标签中发现 PayPal 页面，正在接管继续执行。', 'info');
        return discoveredPayPalTabId;
      }
      const checkoutTabId = await getTabId(PLUS_CHECKOUT_SOURCE);
      if (checkoutTabId) {
        return checkoutTabId;
      }
      const storedTabId = Number(state.plusCheckoutTabId) || 0;
      if (storedTabId) {
        return storedTabId;
      }
      throw new Error('步骤 8：未找到 PayPal 标签页，请先完成步骤 7。');
    }

    async function ensurePayPalReady(tabId, logMessage = '') {
      await waitForTabUrlMatchUntilStopped(tabId, (url) => isPayPalUrl(url));
      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1000);
      await ensureContentScriptReadyOnTabUntilStopped(PAYPAL_SOURCE, tabId, {
        inject: PAYPAL_INJECT_FILES,
        injectSource: PAYPAL_SOURCE,
        logMessage: logMessage || '步骤 8：PayPal 页面仍在加载，等待脚本就绪...',
      });
    }

    async function waitForGuestCheckoutUrl(tabId) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < PAYPAL_GUEST_PAGE_TIMEOUT_MS) {
        throwIfStopped();
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          throw new Error('步骤 8：PayPal 标签页已关闭，无法继续等待 /checkoutweb 页面。');
        }
        const url = String(tab.url || '');
        if (!isPayPalUrl(url)) {
          throw new Error(`步骤 8：标签页已离开 paypal.com（当前 URL：${url}），无法继续填写访客结账信息。`);
        }
        if (isPayPalGuestCheckoutUrl(url)) {
          await waitForTabCompleteUntilStopped(tabId);
          await sleepWithStop(1000);
          return true;
        }
        await sleepWithStop(PAYPAL_GUEST_PAGE_POLL_MS);
      }
      throw new Error('步骤 8：等待 PayPal /checkoutweb 页面超时。');
    }

    async function inspectPayPalPageState(tabId) {
      const state = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
        type: 'PAYPAL_GET_STATE',
        source: 'background',
        payload: {},
      });
      if (state?.error) {
        throw new Error(state.error);
      }
      return state || {};
    }

    async function waitForPayPalPageState(tabId, predicate, options = {}) {
      const {
        timeoutMs = PAYPAL_SMS_PAGE_TIMEOUT_MS,
        pollMs = PAYPAL_GUEST_PAGE_POLL_MS,
        logMessage = '',
      } = options;
      const startedAt = Date.now();
      let logged = false;
      while (Date.now() - startedAt < timeoutMs) {
        throwIfStopped();
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          throw new Error('步骤 8：PayPal 标签页已关闭，无法继续。');
        }
        const url = String(tab.url || '');
        if (!isPayPalUrl(url)) {
          return { state: null, tab, leftPayPal: true };
        }
        await ensurePayPalReady(tabId);
        const pageState = await inspectPayPalPageState(tabId);
        if (predicate(pageState, tab)) {
          return { state: pageState, tab, leftPayPal: false };
        }
        if (logMessage && !logged) {
          logged = true;
          await addLog(logMessage, 'info');
        }
        await sleepWithStop(pollMs);
      }
      throw new Error('步骤 8：等待 PayPal 页面状态变化超时。');
    }

    async function sendPayPalCommandOnce(tabId, message) {
      return chrome.tabs.sendMessage(tabId, {
        source: 'background',
        ...(message || {}),
      });
    }

    async function fillSmsCodeWithNavigationRecovery(tabId, code) {
      try {
        const result = await sendPayPalCommandOnce(tabId, {
          type: 'PAYPAL_FILL_SMS_CODE',
          payload: { code },
        });
        if (result?.error) {
          throw new Error(result.error);
        }
        return result || { code };
      } catch (error) {
        if (!isRetryablePayPalTransportError(error)) {
          throw error;
        }
        await addLog('步骤 8：验证码输入后 PayPal 正在切换到授权确认页，正在重新接管当前页面...', 'info');
        return { code, navigated: true };
      }
    }

    async function clickConsentWithNavigationRecovery(tabId) {
      try {
        const result = await sendPayPalCommandOnce(tabId, {
          type: 'PAYPAL_CLICK_CONSENT',
          payload: {},
        });
        if (result?.error) {
          throw new Error(result.error);
        }
        return result || { clicked: true };
      } catch (error) {
        if (!isRetryablePayPalTransportError(error)) {
          throw error;
        }
        await addLog('步骤 8：点击授权后 PayPal 页面正在跳转，继续进入回跳确认。', 'info');
        return { clicked: true, navigated: true };
      }
    }

    async function waitForConsentAndClick(tabId) {
      const startedAt = Date.now();
      let logged = false;
      while (Date.now() - startedAt < PAYPAL_CONSENT_PAGE_TIMEOUT_MS) {
        throwIfStopped();
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          throw new Error('步骤 8：PayPal 标签页已关闭，无法点击授权按钮。');
        }
        const url = String(tab.url || '');
        if (!isPayPalUrl(url)) {
          await addLog(`步骤 8：PayPal 已离开授权域名（当前 URL：${url}），视为授权点击已提交，交给下一步确认回跳。`, 'info');
          return { clicked: true, leftPayPal: true };
        }

        await ensurePayPalReady(tabId, '步骤 8：PayPal 授权确认页正在加载，等待脚本重新就绪...');
        const pageState = await inspectPayPalPageState(tabId);
        if (pageState?.hasConsentButton) {
          await addLog('步骤 8：检测到 PayPal “Agree and Continue”，正在点击授权...', 'info');
          return clickConsentWithNavigationRecovery(tabId);
        }

        if (!logged) {
          logged = true;
          await addLog('步骤 8：验证码已提交，正在等待 PayPal 授权确认页出现...', 'info');
        }
        await sleepWithStop(PAYPAL_CONSENT_PAGE_POLL_MS);
      }
      throw new Error('步骤 8：等待 PayPal “Agree and Continue” 授权按钮超时。');
    }

    async function executePayPalApprove(state = {}) {
      const cardNumber = String(state?.bindCardNumber || '').trim();
      const phone = String(state?.paypalSmsPhone || '').trim();
      if (!cardNumber) {
        throw new Error('步骤 8：缺少绑卡 0 刀卡卡号，请先在侧边栏「绑卡」配置项里填写。');
      }
      if (!phone) {
        throw new Error('步骤 8：缺少 PayPal 接码手机号，请先在侧边栏「PayPal 手机」配置项里填写。');
      }

      const tabId = await resolvePayPalTabId(state);
      await ensurePayPalReady(tabId);
      await setState({ plusCheckoutTabId: tabId });

      const initialTab = await chrome.tabs.get(tabId).catch(() => null);
      const initialUrl = String(initialTab?.url || '');
      let initialPageState = null;
      try {
        initialPageState = await inspectPayPalPageState(tabId);
      } catch {
        initialPageState = null;
      }

      if (isPayPalGuestLoginUrl(initialUrl)) {
        await addLog('步骤 8：检测到 PayPal /pay 访客登录页，正在填写随机邮箱并下一步...', 'info');
        const loginResult = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
          type: 'PAYPAL_RUN_GUEST_LOGIN',
          source: 'background',
          payload: {},
        });
        if (loginResult?.error) {
          throw new Error(loginResult.error);
        }
        await addLog('步骤 8：/pay 已提交，等待跳转到 /checkoutweb 访客结账页...', 'info');
        await waitForGuestCheckoutUrl(tabId);
        await ensurePayPalReady(tabId, '步骤 8：/checkoutweb 页面正在加载，等待脚本重新就绪...');
      } else if (initialPageState?.hasSmsCodeInputs) {
        await addLog('步骤 8：检测到 PayPal 已在短信验证页，跳过访客结账填写，继续接码。', 'info');
      } else if (isPayPalGuestCheckoutUrl(initialUrl)) {
        // Continue below into the normal /checkoutweb guest checkout submit.
      } else if (initialPageState?.hasConsentButton) {
        await addLog('步骤 8：检测到 PayPal 已在授权确认页，直接点击 “Agree and Continue”。', 'info');
        await waitForConsentAndClick(tabId);
        await setState({ plusPaypalApprovedAt: Date.now() });
        await completeNodeFromBackground('paypal-approve', {
          plusPaypalApprovedAt: Date.now(),
        });
        return;
      } else if (!isPayPalGuestCheckoutUrl(initialUrl)) {
        await addLog(`步骤 8：当前 PayPal 页面 (${initialUrl}) 既不是 /pay 也不是 /checkoutweb，等待跳转到 /checkoutweb...`, 'warn');
        await waitForGuestCheckoutUrl(tabId);
        await ensurePayPalReady(tabId, '步骤 8：/checkoutweb 页面正在加载，等待脚本重新就绪...');
      }

      let checkoutResult = {};
      if (!initialPageState?.hasSmsCodeInputs) {
        await addLog('步骤 8：正在 /checkoutweb 填写访客结账信息（邮箱/密码随机，电话/卡号取自侧边栏配置）...', 'info');
        checkoutResult = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
          type: 'PAYPAL_RUN_GUEST_CHECKOUT',
          source: 'background',
          payload: {
            cardNumber,
            phone,
          },
        });
        if (checkoutResult?.error) {
          throw new Error(checkoutResult.error);
        }
      }

      const smsApiUrl = String(state?.paypalSmsApiUrl || '').trim();
      if (!smsApiUrl) {
        throw new Error('步骤 8：缺少 PayPal 接码 API 地址，请先在侧边栏「PayPal 接码 API」配置项里填写。');
      }

      if (!initialPageState?.hasSmsCodeInputs) {
        await addLog('步骤 8：/checkoutweb 已提交订单，等待 PayPal 短信验证页面加载...', 'info');
        await waitForPayPalPageState(
          tabId,
          (pageState) => Boolean(pageState?.hasSmsCodeInputs),
          {
            timeoutMs: PAYPAL_SMS_PAGE_TIMEOUT_MS,
            logMessage: '步骤 8：PayPal 订单已提交，正在等待短信验证码输入框出现...',
          }
        );
      }

      await addLog('步骤 8：正在从接码平台轮询 PayPal 验证码（最长 3 分钟）...', 'info');
      const smsResult = await sendTabMessageUntilStopped(tabId, PAYPAL_SOURCE, {
        type: 'PAYPAL_WAIT_SMS_CODE',
        source: 'background',
        payload: { apiUrl: smsApiUrl },
      });
      if (smsResult?.error) {
        throw new Error(smsResult.error);
      }

      await fillSmsCodeWithNavigationRecovery(tabId, smsResult?.code || '');
      await waitForConsentAndClick(tabId);

      await setState({ plusPaypalApprovedAt: Date.now() });
      await addLog(`步骤 8：已填入 PayPal 验证码 ${smsResult?.code || '******'} 并点击 “Agree and Continue”。`, 'ok');

      await completeNodeFromBackground('paypal-approve', {
        plusPaypalApprovedAt: Date.now(),
        plusPaypalGuestEmail: String(checkoutResult?.email || '').trim(),
        plusPaypalSmsCode: String(smsResult?.code || '').trim(),
      });
    }

    return {
      executePayPalApprove,
    };
  }

  return {
    createPayPalApproveExecutor,
  };
});
