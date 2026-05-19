(function attachBackgroundPlusCheckoutCreate(root, factory) {
  root.MultiPageBackgroundPlusCheckoutCreate = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPlusCheckoutCreateModule() {
  const PLUS_CHECKOUT_SOURCE = 'plus-checkout';
  const PLUS_CHECKOUT_ENTRY_URL = 'https://chatgpt.com/';
  const PLUS_CHECKOUT_INJECT_FILES = ['content/utils.js', 'content/operation-delay.js', 'content/plus-checkout.js'];

  function createPlusCheckoutCreateExecutor(deps = {}) {
    const {
      addLog: rawAddLog = async () => {},
      applyRegionalProxy = null,
      chrome,
      completeNodeFromBackground,
      createAutomationTab = null,
      ensureContentScriptReadyOnTabUntilStopped,
      registerTab,
      sendTabMessageUntilStopped,
      setState,
      sleepWithStop,
      waitForTabCompleteUntilStopped,
    } = deps;

    function addLog(message, level = 'info', options = {}) {
      return rawAddLog(message, level, {
        step: 6,
        stepKey: 'plus-checkout-create',
        ...(options && typeof options === 'object' ? options : {}),
      });
    }

    async function openFreshChatGptTabForCheckoutCreate() {
      const tab = typeof createAutomationTab === 'function'
        ? await createAutomationTab({ url: PLUS_CHECKOUT_ENTRY_URL, active: true })
        : await chrome.tabs.create({ url: PLUS_CHECKOUT_ENTRY_URL, active: true });
      const tabId = Number(tab?.id);
      if (!Number.isInteger(tabId)) {
        throw new Error('步骤 6：打开 ChatGPT 页面失败，无法创建订阅页。');
      }
      if (typeof registerTab === 'function') {
        await registerTab(PLUS_CHECKOUT_SOURCE, tabId);
      }
      return tabId;
    }

    async function executePlusCheckoutCreate() {
      await addLog('步骤 6：正在打开新的 ChatGPT 会话，准备创建 hosted Plus Checkout 长链接...', 'info');
      const tabId = await openFreshChatGptTabForCheckoutCreate();

      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1000);
      await ensureContentScriptReadyOnTabUntilStopped(PLUS_CHECKOUT_SOURCE, tabId, {
        inject: PLUS_CHECKOUT_INJECT_FILES,
        injectSource: PLUS_CHECKOUT_SOURCE,
        logMessage: '步骤 6：正在等待 ChatGPT 页面完成加载，再继续创建订阅页...',
      });

      const result = await sendTabMessageUntilStopped(tabId, PLUS_CHECKOUT_SOURCE, {
        type: 'CREATE_PLUS_CHECKOUT',
        source: 'background',
        payload: {},
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      if (!result?.checkoutUrl) {
        throw new Error('步骤 6：Plus Checkout 未返回可用的 hosted 长链接。');
      }

      if (typeof applyRegionalProxy === 'function') {
        await applyRegionalProxy('us');
        await addLog('步骤 6：已创建 hosted 长链接，进入支付页前切换到美国代理。', 'info');
      }

      await addLog('步骤 6：hosted 长链接已创建，正在跳转到订阅页面...', 'ok');
      await chrome.tabs.update(tabId, { url: result.checkoutUrl, active: true });
      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1000);
      await ensureContentScriptReadyOnTabUntilStopped(PLUS_CHECKOUT_SOURCE, tabId, {
        inject: PLUS_CHECKOUT_INJECT_FILES,
        injectSource: PLUS_CHECKOUT_SOURCE,
        logMessage: '步骤 6：正在等待订阅页面完成加载...',
      });

      await setState({
        plusCheckoutTabId: tabId,
        plusCheckoutUrl: result.checkoutUrl,
        plusCheckoutCountry: result.country || 'US',
        plusCheckoutCurrency: result.currency || 'USD',
        plusCheckoutSource: '',
      });

      await addLog(`步骤 6：Plus Checkout 页面已就绪（PayPal / ${result.country || 'US'} ${result.currency || 'USD'}），准备继续下一步。`, 'info');

      await completeNodeFromBackground('plus-checkout-create', {
        plusCheckoutCountry: result.country || 'US',
        plusCheckoutCurrency: result.currency || 'USD',
      });
    }

    return {
      executePlusCheckoutCreate,
    };
  }

  return {
    createPlusCheckoutCreateExecutor,
  };
});
