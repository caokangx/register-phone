(function attachBackgroundPlusCheckoutBilling(root, factory) {
  root.MultiPageBackgroundPlusCheckoutBilling = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPlusCheckoutBillingModule() {
  const PLUS_CHECKOUT_SOURCE = 'plus-checkout';
  const PLUS_CHECKOUT_INJECT_FILES = ['content/utils.js', 'content/operation-delay.js', 'content/plus-checkout.js'];
  const HOSTED_CHECKOUT_URL_PATTERN = /^https?:\/\/(?:pay\.openai\.com|checkout\.stripe\.com)\//i;
  const HOSTED_CHECKOUT_REDIRECT_TIMEOUT_MS = 60000;

  function createPlusCheckoutBillingExecutor(deps = {}) {
    const {
      addLog: rawAddLog = async () => {},
      chrome,
      completeNodeFromBackground,
      ensureContentScriptReadyOnTabUntilStopped,
      getState,
      getTabId,
      isTabAlive,
      queryTabsInAutomationWindow = null,
      sendTabMessageUntilStopped,
      setState,
      sleepWithStop,
      waitForTabCompleteUntilStopped,
      throwIfStopped = () => {},
    } = deps;

    function addLog(message, level = 'info', options = {}) {
      return rawAddLog(message, level, {
        step: 7,
        stepKey: 'plus-checkout-billing',
        ...(options && typeof options === 'object' ? options : {}),
      });
    }

    function isHostedCheckoutUrl(url = '') {
      return HOSTED_CHECKOUT_URL_PATTERN.test(String(url || ''));
    }

    function isPayPalUrl(url = '') {
      return /^https?:\/\/[^/]*paypal\.com\//i.test(String(url || ''));
    }

    async function getAlivePlusCheckoutTabId(tabId) {
      if (!Number.isInteger(tabId) || tabId <= 0) {
        return null;
      }
      if (!chrome?.tabs?.get) {
        return tabId;
      }
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) {
        return null;
      }
      const url = String(tab.url || '');
      if (isHostedCheckoutUrl(url) || isPayPalUrl(url)) {
        return tabId;
      }
      return null;
    }

    async function getCurrentHostedCheckoutTabId() {
      if (!chrome?.tabs?.query) {
        return null;
      }
      const queryTabs = typeof queryTabsInAutomationWindow === 'function'
        ? queryTabsInAutomationWindow
        : (queryInfo) => chrome.tabs.query(queryInfo);
      const activeTabs = await queryTabs({ active: true, currentWindow: true }).catch(() => []);
      const activeCheckoutTab = activeTabs.find((tab) => Number.isInteger(tab?.id) && isHostedCheckoutUrl(tab.url));
      if (activeCheckoutTab) {
        return activeCheckoutTab.id;
      }
      const candidates = await queryTabs({}).catch(() => []);
      const hosted = (Array.isArray(candidates) ? candidates : []).find(
        (tab) => Number.isInteger(tab?.id) && isHostedCheckoutUrl(tab.url),
      );
      return hosted?.id || null;
    }

    async function getCheckoutTabId(state = {}) {
      const registeredTabId = await getTabId(PLUS_CHECKOUT_SOURCE);
      if (registeredTabId && await isTabAlive(PLUS_CHECKOUT_SOURCE)) {
        const aliveRegistered = await getAlivePlusCheckoutTabId(registeredTabId);
        if (aliveRegistered) {
          return aliveRegistered;
        }
      }
      const storedTabId = Number(state.plusCheckoutTabId) || 0;
      if (storedTabId) {
        const aliveStored = await getAlivePlusCheckoutTabId(storedTabId);
        if (aliveStored) {
          return aliveStored;
        }
      }
      const currentHosted = await getCurrentHostedCheckoutTabId();
      if (currentHosted) {
        await addLog('步骤 7：检测到当前已在 hosted 订阅页，直接接管当前标签页。', 'info');
        return currentHosted;
      }
      throw new Error('步骤 7：未找到 hosted Plus Checkout 标签页。请先完成步骤 6。');
    }

    async function waitForPayPalRedirect(tabId) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < HOSTED_CHECKOUT_REDIRECT_TIMEOUT_MS) {
        throwIfStopped();
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          throw new Error('步骤 7：checkout 标签页已关闭，无法继续等待 PayPal 跳转。');
        }
        const url = String(tab.url || '');
        if (isPayPalUrl(url)) {
          await waitForTabCompleteUntilStopped(tabId);
          await sleepWithStop(1000);
          return true;
        }
        if (url && !isHostedCheckoutUrl(url)) {
          await addLog(`步骤 7：提交后页面跳转到非预期地址：${url}`, 'warn');
        }
        await sleepWithStop(500);
      }
      return false;
    }

    async function executePlusCheckoutBilling(state = {}) {
      const tabId = await getCheckoutTabId(state);
      await addLog('步骤 7：正在等待 hosted Plus Checkout 页面加载完成...', 'info');
      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1000);
      await ensureContentScriptReadyOnTabUntilStopped(PLUS_CHECKOUT_SOURCE, tabId, {
        inject: PLUS_CHECKOUT_INJECT_FILES,
        injectSource: PLUS_CHECKOUT_SOURCE,
        logMessage: '步骤 7：Checkout 页面仍在加载，等待 hosted 自动化脚本就绪...',
      });

      await addLog('步骤 7：正在驱动 hosted 页面选择 PayPal、填写账单地址并提交订阅...', 'info');
      const result = await sendTabMessageUntilStopped(tabId, PLUS_CHECKOUT_SOURCE, {
        type: 'RUN_HOSTED_CHECKOUT_FLOW',
        source: 'background',
        payload: {},
      });
      if (result?.error) {
        throw new Error(result.error);
      }

      await setState({
        plusCheckoutTabId: tabId,
        plusBillingAddress: result?.address || null,
      });

      await addLog('步骤 7：账单地址已提交，正在等待跳转到 PayPal...', 'info');
      const redirected = await waitForPayPalRedirect(tabId);
      if (!redirected) {
        throw new Error('步骤 7：提交订阅后未在 60 秒内跳转到 PayPal。');
      }

      await completeNodeFromBackground('plus-checkout-billing', {
        plusCheckoutTabId: tabId,
        plusBillingAddress: result?.address || null,
      });
    }

    return {
      executePlusCheckoutBilling,
    };
  }

  return {
    createPlusCheckoutBillingExecutor,
  };
});
