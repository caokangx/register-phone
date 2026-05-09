(function attachWhatsappOtpClient(root, factory) {
  root.MultiPageWhatsappOtpClient = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createWhatsappOtpClientModule() {
  const DEFAULT_BASE_URL = 'http://192.168.3.123:8000';
  const REQUEST_TIMEOUT_MS = 8000;
  const UNLINK_REQUEST_TIMEOUT_MS = 20000;

  function getBaseUrl(state = {}) {
    const raw = String(state?.gopayOtpApiBaseUrl || state?.whatsappOtpApiBaseUrl || DEFAULT_BASE_URL || '').trim();
    return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  function buildUrl(state, path) {
    return `${getBaseUrl(state)}${path}`;
  }

  async function readJson(response) {
    const text = await response.text().catch(() => '');
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { __raw: text };
    }
  }

  async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`fetch timeout (>${timeoutMs}ms)`)), timeoutMs)
      : null;
    try {
      return await fetchImpl(url, {
        ...options,
        signal: controller?.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function createWhatsappOtpClient(deps = {}) {
    const {
      addLog = null,
      fetch: fetchImpl = (typeof fetch === 'function' ? fetch.bind(globalThis) : null),
      sleepWithStop = null,
      throwIfStopped = null,
    } = deps;

    if (typeof fetchImpl !== 'function') {
      throw new Error('WhatsApp OTP 客户端初始化失败：当前环境不支持 fetch。');
    }

    async function clearNotifications(state = {}) {
      const url = buildUrl(state, '/notifications/clear');
      console.info('[whatsapp-otp] POST', url);
      let response;
      try {
        response = await fetchWithTimeout(fetchImpl, url, { method: 'POST' });
      } catch (err) {
        throw new Error(`WhatsApp /notifications/clear 请求失败（${url}）：${err?.message || String(err || '')}`);
      }
      const payload = await readJson(response);
      if (!response.ok || payload?.ok !== true) {
        const detail = payload?.__raw || payload?.message || `HTTP ${response.status}`;
        throw new Error(`WhatsApp /notifications/clear 调用失败（${url}）：${detail}`);
      }
      return { ok: true, cleared: payload?.cleared !== false };
    }

    async function unlinkWhatsapp(state = {}) {
      const url = buildUrl(state, '/unlink');
      console.info('[whatsapp-otp] POST', url);
      let response;
      try {
        response = await fetchWithTimeout(fetchImpl, url, { method: 'POST' }, UNLINK_REQUEST_TIMEOUT_MS);
      } catch (err) {
        throw new Error(`WhatsApp /unlink 请求失败（${url}）：${err?.message || String(err || '')}`);
      }
      const payload = await readJson(response);
      if (!response.ok || payload?.ok !== true) {
        const detail = payload?.__raw || payload?.message || `HTTP ${response.status}`;
        throw new Error(`WhatsApp /unlink 调用失败（${url}）：${detail}`);
      }
      return true;
    }

    async function fetchOtpOnce(state = {}) {
      const url = buildUrl(state, '/whatsapp/code');
      console.info('[whatsapp-otp] GET', url);
      let response;
      try {
        response = await fetchWithTimeout(fetchImpl, url, { method: 'GET' });
      } catch (err) {
        throw new Error(`WhatsApp /whatsapp/code 请求失败（${url}）：${err?.message || String(err || '')}`);
      }
      const payload = await readJson(response);
      if (!response.ok) {
        const detail = payload?.__raw || payload?.message || `HTTP ${response.status}`;
        throw new Error(`WhatsApp /whatsapp/code 返回错误（${url}）：${detail}`);
      }
      const code = String(payload?.code || '').trim();
      return code;
    }

    async function pollOtp(state = {}, options = {}) {
      const intervalMs = Math.max(500, Math.floor(Number(options.intervalMs) || 3000));
      const timeoutMs = Math.max(intervalMs, Math.floor(Number(options.timeoutMs) || 180000));
      const label = String(options.label || 'WhatsApp 验证码');
      const stepLabel = String(options.stepLabel || '步骤 8');
      const clearAfterRead = options.clearAfterRead !== false;
      const failuresThreshold = Math.max(0, Math.floor(Number(options.failuresThreshold) || 0));
      const onConsecutiveFailures = typeof options.onConsecutiveFailures === 'function'
        ? options.onConsecutiveFailures
        : null;
      const url = buildUrl(state, '/whatsapp/code');
      const startedAt = Date.now();
      let attempt = 0;
      let consecutiveFailures = 0;
      let lastError = null;

      if (typeof addLog === 'function') {
        await addLog(`${stepLabel}：开始向 ${url} 轮询 ${label}（间隔 ${intervalMs}ms，超时 ${Math.round(timeoutMs / 1000)}s）。`, 'info');
      }

      while (true) {
        if (typeof throwIfStopped === 'function') throwIfStopped();
        attempt += 1;
        let succeededFetch = false;
        try {
          const code = await fetchOtpOnce(state);
          if (code) {
            if (clearAfterRead) {
              try {
                await clearNotifications(state);
                if (typeof addLog === 'function') {
                  await addLog(`${stepLabel}：已读取 ${label}，并清理手机通知，避免下次重复读取旧验证码。`, 'info');
                }
              } catch (clearError) {
                if (typeof addLog === 'function') {
                  await addLog(`${stepLabel}：已读取 ${label}，但清理手机通知失败：${clearError?.message || String(clearError || '')}`, 'warn');
                }
              }
            }
            return code;
          }
          succeededFetch = true;
          if (typeof addLog === 'function' && attempt === 1) {
            await addLog(`${stepLabel}：${label}首次请求成功，但接口尚未返回 code，将继续轮询。`, 'info');
          }
        } catch (err) {
          lastError = err;
          if (typeof addLog === 'function') {
            await addLog(`${stepLabel}：${label}第 ${attempt} 次拉取失败：${err?.message || String(err || '')}（继续重试）`, 'warn');
          }
        }

        consecutiveFailures += 1;

        if (
          failuresThreshold > 0
          && onConsecutiveFailures
          && consecutiveFailures >= failuresThreshold
        ) {
          try {
            const handled = await onConsecutiveFailures({
              attempts: consecutiveFailures,
              totalAttempts: attempt,
              lastError,
              succeededFetch,
            });
            if (handled) {
              consecutiveFailures = 0;
              lastError = null;
            }
          } catch (handlerError) {
            if (typeof addLog === 'function') {
              await addLog(`${stepLabel}：连续 ${consecutiveFailures} 次未拉到 ${label}，触发兜底动作时失败：${handlerError?.message || String(handlerError || '')}`, 'warn');
            }
          }
        }

        if (Date.now() - startedAt >= timeoutMs) {
          const tail = lastError ? `最后错误：${lastError.message}` : '接口暂未返回验证码。';
          throw new Error(`${stepLabel}：等待 ${label} 超时（>${Math.round(timeoutMs / 1000)}s，已尝试 ${attempt} 次）。${tail}`);
        }
        if (typeof sleepWithStop === 'function') {
          await sleepWithStop(intervalMs);
        } else {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }
    }

    async function fetchBalance(state = {}, fetchOptions = {}) {
      const perRequestTimeoutMs = Math.max(
        500,
        Math.floor(Number(fetchOptions.timeoutMs) || REQUEST_TIMEOUT_MS)
      );
      const url = buildUrl(state, '/balance');
      console.info('[whatsapp-otp] GET', url);
      let response;
      try {
        response = await fetchWithTimeout(fetchImpl, url, { method: 'GET' }, perRequestTimeoutMs);
      } catch (err) {
        throw new Error(`WhatsApp /balance 请求失败（${url}）：${err?.message || String(err || '')}`);
      }
      const payload = await readJson(response);
      if (!response.ok) {
        const detail = payload?.__raw || payload?.message || `HTTP ${response.status}`;
        throw new Error(`WhatsApp /balance 返回错误（${url}）：${detail}`);
      }
      const raw = String(payload?.balance || '').trim();
      return { raw, payload };
    }

    function parseBalanceValue(rawText = '') {
      if (!rawText) return null;
      const digitsOnly = String(rawText).replace(/[^\d]/g, '');
      if (!digitsOnly) return null;
      const value = Number.parseInt(digitsOnly, 10);
      return Number.isFinite(value) ? value : null;
    }

    async function pollBalance(state = {}, options = {}) {
      const intervalMs = Math.max(500, Math.floor(Number(options.intervalMs) || 5000));
      const rawTimeoutInput = options.timeoutMs;
      const timeoutMs = rawTimeoutInput === 0
        || rawTimeoutInput === Infinity
        || rawTimeoutInput === null
        || rawTimeoutInput === undefined
          ? Infinity
          : Math.max(intervalMs, Math.floor(Number(rawTimeoutInput) || 0));
      const isInfinite = !Number.isFinite(timeoutMs);
      const stepLabel = String(options.stepLabel || '步骤 15');
      const requestTimeoutMs = Math.max(
        500,
        Math.floor(Number(options.requestTimeoutMs) || REQUEST_TIMEOUT_MS)
      );
      const url = buildUrl(state, '/balance');
      const startedAt = Date.now();
      let attempt = 0;
      let lastError = null;
      let lastRaw = '';

      if (typeof addLog === 'function') {
        const timeoutDesc = isInfinite ? '无超时（直到余额到账或用户停止）' : `超时 ${Math.round(timeoutMs / 1000)}s`;
        await addLog(
          `${stepLabel}：开始轮询 ${url}（间隔 ${intervalMs}ms，单次请求超时 ${Math.round(requestTimeoutMs / 1000)}s，${timeoutDesc}），等待余额 > 0。`,
          'info'
        );
      }

      while (true) {
        if (typeof throwIfStopped === 'function') throwIfStopped();
        attempt += 1;
        try {
          const { raw } = await fetchBalance(state, { timeoutMs: requestTimeoutMs });
          lastRaw = raw;
          const value = parseBalanceValue(raw);
          if (Number.isFinite(value) && value > 0) {
            return { value, raw, attempts: attempt };
          }
          if (typeof addLog === 'function') {
            await addLog(`${stepLabel}：第 ${attempt} 次查询余额 = ${raw || '(空)'}，仍未到账，继续等待。`, 'info');
          }
        } catch (err) {
          lastError = err;
          if (typeof addLog === 'function') {
            await addLog(`${stepLabel}：第 ${attempt} 次查询余额失败：${err?.message || String(err || '')}（继续重试）`, 'warn');
          }
        }
        if (!isInfinite && Date.now() - startedAt >= timeoutMs) {
          const detail = lastError ? `最后错误：${lastError.message}` : `最后查询余额：${lastRaw || '(空)'}`;
          throw new Error(`${stepLabel}：等待账户余额到账超时（>${Math.round(timeoutMs / 1000)}s，已尝试 ${attempt} 次）。${detail}`);
        }
        if (typeof sleepWithStop === 'function') {
          await sleepWithStop(intervalMs);
        } else {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }
    }

    return {
      DEFAULT_BASE_URL,
      clearNotifications,
      fetchBalance,
      fetchOtpOnce,
      parseBalanceValue,
      pollBalance,
      pollOtp,
      unlinkWhatsapp,
    };
  }

  return {
    createWhatsappOtpClient,
    DEFAULT_BASE_URL,
  };
});
