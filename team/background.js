// Service worker：循环控制 + OpenAI 缓存清理 + localhost 回调捕获 + sub2api 交换。
importScripts('lib/sub2api.js');
importScripts('lib/sms.js');

const LOG_PREFIX = '[sub2api-auto]';

const CONFIG_KEYS = [
  'sub2apiUrl',
  'sub2apiEmail',
  'sub2apiPassword',
  'selectedGroupNames',
  'proxyPreference',
  'emailPrefix',
  'emailDomain',
  'loopCount',
  'roundTimeoutSec',
  'loopDelaySec',
  'smsEnabled',
  'smsBaseUrl',
  'smsApiKey',
  'smsCountry',
  'smsDialCode',
  'smsCountryLabel',
  'smsCodeTimeoutSec',
  'smsMinPrice',
  'smsMaxPrice',
  'smsFixedPrice',
  'smsMaxReplacements',
];

// localStorage / indexedDB 只能按精确 origin 清，枚举 openai 登录相关子域（含 sentinel/auth）
const OPENAI_ORIGINS = [
  'https://chatgpt.com', 'https://www.chatgpt.com', 'https://ab.chatgpt.com',
  'https://chat.openai.com', 'https://openai.com', 'https://www.openai.com',
  'https://auth.openai.com', 'https://auth0.openai.com', 'https://accounts.openai.com',
  'https://sentinel.openai.com', 'https://platform.openai.com', 'https://api.openai.com',
  'https://cdn.openai.com', 'https://cdn.oaistatic.com',
];
const OPENAI_COOKIE_DOMAINS = [
  'chatgpt.com',
  'openai.com',
  'oaistatic.com',
  'oaiusercontent.com',
];
const OPENAI_TAB_HOST_SUFFIXES = [
  'chatgpt.com',
  'openai.com',
  'oaistatic.com',
  'oaiusercontent.com',
];
const WEB_ORIGIN_TYPES = { unprotectedWeb: true, protectedWeb: true };
const COOKIE_COUNT_LIMIT = 100000;

const MAX_LOG = 400;
const TOTAL_STEPS = 7; // 1 生成+打开, 2-6 页面自动化, 7 交换+建号
const ALARM_TIMEOUT = 'round-timeout';
const ALARM_NEXT = 'next-round';

const processedCallbacks = new Set();

// 轮次状态切换串行化，避免 watchdog 与回调竞争
let roundMutex = Promise.resolve();
function withLock(fn) {
  const run = roundMutex.then(fn, fn);
  roundMutex = run.catch(() => {});
  return run;
}

// 允许 content script 读取 storage.session
async function ensureSessionAccess() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'setAccessLevel 失败', err);
  }
}
ensureSessionAccess();
chrome.runtime.onInstalled.addListener(ensureSessionAccess);
chrome.runtime.onStartup.addListener(ensureSessionAccess);

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ===== 日志 =====
async function addLog(message, level = 'info', step = null) {
  const entry = { timestamp: Date.now(), level, message, step: step || null };
  const s = await chrome.storage.session.get(['logs']);
  const logs = Array.isArray(s.logs) ? s.logs : [];
  logs.push(entry);
  if (logs.length > MAX_LOG) logs.splice(0, logs.length - MAX_LOG);
  const update = { logs, status: entry };
  if (step !== null) update.currentStep = step;
  await chrome.storage.session.set(update);
  console.log(LOG_PREFIX, `${step ? `[步${step}] ` : ''}${message}`);
  broadcast({ type: 'LOG', entry, currentStep: step !== null ? step : undefined, totalSteps: TOTAL_STEPS });
}

// ===== 配置 =====
async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEYS);
  return {
    sub2apiUrl: '',
    sub2apiEmail: '',
    sub2apiPassword: '',
    selectedGroupNames: [],
    proxyPreference: '',
    emailPrefix: '',
    emailDomain: '',
    loopCount: '',
    roundTimeoutSec: '',
    loopDelaySec: '',
    smsEnabled: false,
    smsBaseUrl: Sms.DEFAULT_BASE_URL,
    smsApiKey: '',
    smsCountry: Sms.DEFAULT_COUNTRY,
    smsDialCode: '66',
    smsCountryLabel: 'Thailand',
    smsCodeTimeoutSec: '',
    smsMinPrice: '',
    smsMaxPrice: '',
    smsFixedPrice: false,
    smsMaxReplacements: '',
    ...stored,
  };
}

function validateConfig(config) {
  if (!config.sub2apiUrl) throw new Error('请填写 SUB2API 网址。');
  if (!config.sub2apiEmail) throw new Error('请填写 SUB2API 登录邮箱。');
  if (!config.sub2apiPassword) throw new Error('请填写 SUB2API 登录密码。');
  if (!Array.isArray(config.selectedGroupNames) || !config.selectedGroupNames.length) {
    throw new Error('请至少勾选一个分组。');
  }
  if (!config.emailPrefix) throw new Error('请填写邮箱前缀。');
  if (!config.emailDomain) throw new Error('请填写邮箱域名。');
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ===== 彻底清理登录态 =====
// 关键点：OpenAI 的会话 cookie 多为「分区 cookie(CHIPS)」，chrome.cookies.getAll() 看不到；
// 且 SSO 登录态在第三方 IdP 域名（未知）上。两者都无法按域名精确清，
// 因此用 browsingData 全局清 cookie（含分区 cookie + 所有域名，覆盖 SSO IdP），再叠加缓存/SW/本地存储。
function isOpenAiUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OPENAI_TAB_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

async function closeOpenAiTabs() {
  if (!chrome.tabs?.query || !chrome.tabs?.remove) return 0;
  const [{ authTabId }, tabs] = await Promise.all([
    chrome.storage.session.get(['authTabId']).catch(() => ({})),
    chrome.tabs.query({}).catch(() => []),
  ]);
  const ids = new Set();
  if (authTabId) ids.add(authTabId);
  for (const tab of tabs) {
    if (isOpenAiUrl(tab.url || tab.pendingUrl) && tab.id) ids.add(tab.id);
  }
  const tabIds = [...ids];
  if (tabIds.length) await chrome.tabs.remove(tabIds).catch((err) => console.warn(LOG_PREFIX, '关闭 OpenAI 标签页失败', err));
  await chrome.storage.session.remove(['authTabId']).catch(() => {});
  return tabIds.length;
}

function cookieRemovalUrl(cookie) {
  const domain = String(cookie.domain || '').replace(/^\./, '');
  const protocol = cookie.secure ? 'https:' : 'http:';
  return `${protocol}//${domain}${cookie.path || '/'}`;
}

async function removeCookie(cookie) {
  if (!chrome.cookies?.remove) return;
  const details = {
    url: cookieRemovalUrl(cookie),
    name: cookie.name,
    storeId: cookie.storeId,
  };
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
  await chrome.cookies.remove(details).catch((err) => console.warn(LOG_PREFIX, `删除 cookie 失败：${cookie.domain} ${cookie.name}`, err));
}

async function getCookieStoreIds() {
  if (!chrome.cookies?.getAllCookieStores) return [undefined];
  const stores = await chrome.cookies.getAllCookieStores().catch((err) => {
    console.warn(LOG_PREFIX, '枚举 cookie store 失败', err);
    return [];
  });
  const ids = stores.map((store) => store.id).filter(Boolean);
  return ids.length ? ids : [undefined];
}

function withStoreId(details, storeId) {
  return storeId ? { ...details, storeId } : details;
}

async function removeOpenAiCookiesByApi() {
  if (!chrome.cookies?.getAll) return { before: 0, after: 0 };
  const storeIds = await getCookieStoreIds();
  const cookies = [];
  const seen = new Set();

  for (const storeId of storeIds) {
    for (const domain of OPENAI_COOKIE_DOMAINS) {
      const batches = await Promise.all([
        chrome.cookies.getAll(withStoreId({ domain }, storeId)).catch((err) => {
          console.warn(LOG_PREFIX, `枚举未分区 cookie 失败：${domain}`, err);
          return [];
        }),
        chrome.cookies.getAll(withStoreId({ domain, partitionKey: {} }, storeId)).catch((err) => {
          console.warn(LOG_PREFIX, `枚举分区 cookie 失败：${domain}`, err);
          return [];
        }),
      ]);
      const found = batches.flat();
      for (const cookie of found) {
        const key = `${cookie.storeId}|${cookie.domain}|${cookie.path}|${cookie.name}|${JSON.stringify(cookie.partitionKey || null)}`;
        if (!seen.has(key)) {
          seen.add(key);
          cookies.push(cookie);
        }
      }
    }
  }

  await Promise.all(cookies.map(removeCookie));

  let after = 0;
  for (const storeId of storeIds) {
    for (const domain of OPENAI_COOKIE_DOMAINS) {
      const batches = await Promise.all([
        chrome.cookies.getAll(withStoreId({ domain }, storeId)).catch(() => []),
        chrome.cookies.getAll(withStoreId({ domain, partitionKey: {} }, storeId)).catch(() => []),
      ]);
      const seenAfter = new Set();
      for (const cookie of batches.flat()) {
        seenAfter.add(`${cookie.storeId}|${cookie.domain}|${cookie.path}|${cookie.name}|${JSON.stringify(cookie.partitionKey || null)}`);
      }
      after += seenAfter.size;
    }
  }
  return { before: cookies.length, after, stores: storeIds.length };
}

async function removeAllVisibleCookiesByApi() {
  if (!chrome.cookies?.getAll) return { before: 0, after: 0, stores: 0 };
  const storeIds = await getCookieStoreIds();
  const cookies = [];
  const seen = new Set();

  for (const storeId of storeIds) {
    const found = await chrome.cookies.getAll(withStoreId({}, storeId)).catch((err) => {
      console.warn(LOG_PREFIX, `枚举全部 cookie 失败：${storeId || 'default'}`, err);
      return [];
    });
    for (const cookie of found.slice(0, COOKIE_COUNT_LIMIT)) {
      const key = `${cookie.storeId}|${cookie.domain}|${cookie.path}|${cookie.name}|${JSON.stringify(cookie.partitionKey || null)}`;
      if (!seen.has(key)) {
        seen.add(key);
        cookies.push(cookie);
      }
    }
  }

  await Promise.all(cookies.map(removeCookie));

  let after = 0;
  for (const storeId of storeIds) {
    const found = await chrome.cookies.getAll(withStoreId({}, storeId)).catch(() => []);
    after += found.length;
  }
  return { before: cookies.length, after, stores: storeIds.length };
}

async function clearBrowsingData() {
  const closedTabs = await closeOpenAiTabs();
  const allCookieCounts = await removeAllVisibleCookiesByApi();
  const openAiCookieCounts = await removeOpenAiCookiesByApi();

  if (chrome.browsingData?.remove) {
    // 1) 全局清 cookie + HTTP 缓存 + CacheStorage + ServiceWorker。
    //    originTypes 覆盖 protectedWeb，避免站点被安装/PWA 化时默认清理漏掉。
    await chrome.browsingData.remove(
      { since: 0, originTypes: WEB_ORIGIN_TYPES },
      { cookies: true, cache: true, cacheStorage: true, serviceWorkers: true },
    ).catch((err) => console.warn(LOG_PREFIX, '全局清理失败', err));
    // 2) 全局清 localStorage / IndexedDB 等站点存储；SSO 登录态可能在非 OpenAI 域。
    await chrome.browsingData.remove(
      { since: 0, originTypes: WEB_ORIGIN_TYPES },
      { localStorage: true, indexedDB: true, webSQL: true, fileSystems: true },
    ).catch((err) => console.warn(LOG_PREFIX, '全局站点存储清理失败', err));
    // 3) 再按 OpenAI 精确 origins 清一遍，覆盖浏览器对全局清理的差异行为。
    await chrome.browsingData.remove(
      { since: 0, origins: OPENAI_ORIGINS, originTypes: WEB_ORIGIN_TYPES },
      { localStorage: true, indexedDB: true, webSQL: true, fileSystems: true },
    ).catch((err) => console.warn(LOG_PREFIX, '清理本地存储失败', err));
  }

  const verifyOpenAiCounts = await removeOpenAiCookiesByApi();
  const verifyAllCounts = chrome.cookies?.getAll ? await (async () => {
    let after = 0;
    const storeIds = await getCookieStoreIds();
    for (const storeId of storeIds) {
      const found = await chrome.cookies.getAll(withStoreId({}, storeId)).catch(() => []);
      after += found.length;
    }
    return { after, stores: storeIds.length };
  })() : { after: 0, stores: 0 };
  return {
    closedTabs,
    cookieStores: verifyAllCounts.stores || allCookieCounts.stores || openAiCookieCounts.stores || 0,
    removedCookies: allCookieCounts.before + openAiCookieCounts.before + verifyOpenAiCounts.before,
    remainingCookies: verifyAllCounts.after,
    remainingOpenAiCookies: verifyOpenAiCounts.after,
  };
}

// ===== 循环状态 =====
async function getLoop() {
  const s = await chrome.storage.session.get(['loop']);
  return s.loop || null;
}
async function setLoop(loop) {
  await chrome.storage.session.set({ loop });
}

function loopSummary(loop) {
  const ok = loop.results.filter((r) => r.status === 'success').length;
  return { total: loop.results.length, ok, fail: loop.results.length - ok };
}

// ===== 启动循环 =====
async function startLoop() {
  const config = await getConfig();
  validateConfig(config);

  const targetCount = clampInt(config.loopCount, 1, 100000, 0) || 0; // 留空/0 = 无限
  const roundTimeoutSec = clampInt(config.roundTimeoutSec, 60, 1800, 240);
  const loopDelaySec = clampInt(config.loopDelaySec, 0, 3600, 0);

  await chrome.alarms.clear(ALARM_TIMEOUT);
  await chrome.alarms.clear(ALARM_NEXT);
  processedCallbacks.clear();

  const loop = {
    active: true,
    targetCount,
    roundTimeoutSec,
    loopDelaySec,
    currentRound: 0,
    finishedRound: 0,
    results: [],
  };
  await setLoop(loop);
  await chrome.storage.session.set({ logs: [], currentStep: 0 });
  await addLog(`开始循环：目标 ${targetCount ? `${targetCount} 轮` : '无限（直到手动停止）'}，单轮超时 ${roundTimeoutSec}s${loopDelaySec ? `，轮间等待 ${loopDelaySec}s` : ''}。`, 'info', 0);
  broadcast({ type: 'LOOP_STATE', active: true });

  await runRound(1);
  return { ok: true };
}

// ===== 单轮执行：清缓存 → 生成链接 → 打开标签 → 设置看门狗 =====
async function runRound(roundIndex) {
  const loop = await getLoop();
  if (!loop || !loop.active) return;
  loop.currentRound = roundIndex;
  await setLoop(loop);

  const config = await getConfig();
  await addLog(`══════ 第 ${roundIndex} 轮开始 ══════`, 'info', 1);
  await addLog('步骤1：正在彻底清理登录态（关闭旧授权页 + 全局 cookie + 全局站点存储 + 缓存 + ServiceWorker）...', 'info', 1);
  const clearResult = await clearBrowsingData();

  const email = `${config.emailPrefix}${Sub2Api.generateRandomSuffix(6)}@${config.emailDomain}`;
  const password = Sub2Api.generatePassword(16);

  try {
    const clearSummary = `关闭相关标签 ${clearResult.closedTabs} 个，cookie store ${clearResult.cookieStores} 个，删除/复查 cookie ${clearResult.removedCookies} 个，全部剩余 ${clearResult.remainingCookies} 个，OpenAI 剩余 ${clearResult.remainingOpenAiCookies} 个`;
    await addLog(`步骤1：登录态清理完成（${clearSummary}），正在向 SUB2API 申请授权链接...`, clearResult.remainingCookies || clearResult.remainingOpenAiCookies ? 'warn' : 'info', 1);
    const result = await Sub2Api.generateAuthUrl(config);

    await chrome.storage.session.set({
      flowActive: true,
      generatedEmail: email,
      generatedPassword: password,
      smsEnabled: Boolean(config.smsEnabled),
      phoneRequested: false,
      phoneReplacements: 0,
      roundStartedAt: Date.now(),
      runtime: {
        email,
        sessionId: result.sessionId,
        oauthState: result.oauthState,
        groupIds: result.groupIds,
        proxyId: result.proxyId,
      },
    });
    await chrome.storage.session.remove(['currentActivation']);

    const tab = await chrome.tabs.create({ url: result.oauthUrl, active: true });
    await chrome.storage.session.set({ authTabId: tab.id });
    await addLog(`步骤1：已打开授权链接（分组：${result.groupLabel}${result.proxyLabel ? `，代理：${result.proxyLabel}` : '，无代理'}）。账号：${email}`, 'ok', 1);

    // 看门狗：超时未捕获回调则判该轮失败
    await chrome.storage.session.set({ watchdogRound: roundIndex });
    await chrome.alarms.create(ALARM_TIMEOUT, { when: Date.now() + loop.roundTimeoutSec * 1000 });
  } catch (err) {
    await finishRound(roundIndex, 'failed', `生成授权链接失败：${err.message}`, { email });
  }
}

// ===== 结束一轮：记录结果并决定是否继续 =====
async function finishRound(roundIndex, status, reason, extra = {}) {
  return withLock(async () => {
    const loop = await getLoop();
    if (!loop) return;
    if (loop.finishedRound >= roundIndex) return; // 已结束，避免重复
    loop.finishedRound = roundIndex;

    const session = await chrome.storage.session.get(['runtime', 'roundStartedAt', 'authTabId']);
    const email = extra.email || session.runtime?.email || '';
    const record = {
      round: roundIndex,
      status,
      reason: reason || '',
      email,
      accountId: extra.accountId || null,
      startedAt: session.roundStartedAt || null,
      finishedAt: Date.now(),
    };
    loop.results.push(record);
    await setLoop(loop);

    await chrome.storage.session.set({ flowActive: false });
    await chrome.alarms.clear(ALARM_TIMEOUT);
    if (session.authTabId) chrome.tabs.remove(session.authTabId).catch(() => {});

    // 结算接码订单：成功 6（完成），失败 8（取消）
    const act = await chrome.storage.session.get(['currentActivation']);
    if (act.currentActivation?.activationId) {
      const config = await getConfig();
      await Sms.setStatus(config, act.currentActivation.activationId, status === 'success' ? 6 : 8);
      await addLog(`接码：已${status === 'success' ? '完成' : '取消'}号码 +${act.currentActivation.phoneNumber} 的订单。`, 'info', null);
    }
    await chrome.storage.session.remove(['currentActivation', 'phoneRequested']);

    const label = status === 'success'
      ? `第 ${roundIndex} 轮成功 ✅（账号 #${extra.accountId || '?'}，${email}）`
      : `第 ${roundIndex} 轮失败 ❌：${reason}`;
    await addLog(label, status === 'success' ? 'ok' : 'error', status === 'success' ? 7 : null);
    broadcast({ type: 'ROUND_RESULT', record, results: loop.results });

    if (!loop.active) {
      await addLog('循环已停止。', 'info', 0);
      broadcast({ type: 'LOOP_STATE', active: false });
      return;
    }
    if (loop.targetCount > 0 && roundIndex >= loop.targetCount) {
      loop.active = false;
      await setLoop(loop);
      const sum = loopSummary(loop);
      await addLog(`循环结束：共 ${sum.total} 轮，成功 ${sum.ok}，失败 ${sum.fail}。`, 'ok', 0);
      broadcast({ type: 'LOOP_DONE', results: loop.results, summary: sum });
      broadcast({ type: 'LOOP_STATE', active: false });
      return;
    }

    const next = roundIndex + 1;
    if (loop.loopDelaySec > 0) {
      await addLog(`等待 ${loop.loopDelaySec}s 后开始第 ${next} 轮...`, 'info', 0);
      await chrome.storage.session.set({ nextRound: next });
      await chrome.alarms.create(ALARM_NEXT, { when: Date.now() + loop.loopDelaySec * 1000 });
    } else {
      await runRound(next);
    }
  });
}

async function stopLoop() {
  const loop = await getLoop();
  if (loop) {
    loop.active = false;
    await setLoop(loop);
  }
  await chrome.alarms.clear(ALARM_TIMEOUT);
  await chrome.alarms.clear(ALARM_NEXT);
  await chrome.storage.session.set({ flowActive: false, currentStep: 0 });
  const session = await chrome.storage.session.get(['authTabId']);
  if (session.authTabId) chrome.tabs.remove(session.authTabId).catch(() => {});
  await chrome.storage.session.remove(['runtime', 'generatedEmail', 'generatedPassword', 'authTabId']);
  await addLog('已手动停止循环。', 'info', 0);
  broadcast({ type: 'LOOP_STATE', active: false });
  return { ok: true };
}

// ===== 回调捕获 =====
async function handleCallback(rawUrl, tabId) {
  const session = await chrome.storage.session.get(['flowActive', 'runtime']);
  if (!session.flowActive) return;
  let parsed;
  try {
    parsed = Sub2Api.parseLocalhostCallback(rawUrl);
  } catch {
    return; // 不是合法 /auth/callback
  }
  // 忽略与当前轮 state 不一致的杂散/过期回调，避免误判当前轮失败
  const expectedState = String(session.runtime?.oauthState || '');
  if (expectedState && parsed.state !== expectedState) return;

  if (processedCallbacks.has(parsed.url)) return;
  processedCallbacks.add(parsed.url);

  const loop = await getLoop();
  const roundIndex = loop?.currentRound || 0;
  const config = await getConfig();
  const runtime = { ...(session.runtime || {}), localhostUrl: parsed.url };

  try {
    await addLog('步骤7：已捕获回调，正在交换授权码并创建账号...', 'info', 7);
    const out = await Sub2Api.exchangeCallback(config, runtime);
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
    await finishRound(roundIndex, 'success', '', { accountId: out.accountId, email: out.email || out.accountName });
  } catch (err) {
    await finishRound(roundIndex, 'failed', `授权码交换失败：${err.message}`, {});
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type !== 'main_frame') return;
    handleCallback(details.url, details.tabId).catch((err) => console.warn(LOG_PREFIX, err));
  },
  { urls: ['http://localhost/*', 'http://127.0.0.1/*', 'https://localhost/*', 'https://127.0.0.1/*'] },
);

// ===== 监听 add-phone/send：失败=手机号异常 → 自动换号重试 =====
let phoneReplacing = false;

const ADD_PHONE_SEND_URLS = ['*://auth.openai.com/api/accounts/add-phone/send*'];
chrome.webRequest.onCompleted.addListener(
  (details) => { onPhoneSendResult(details.statusCode, details.tabId).catch((e) => console.warn(LOG_PREFIX, e)); },
  { urls: ADD_PHONE_SEND_URLS },
);
chrome.webRequest.onErrorOccurred.addListener(
  (details) => { onPhoneSendResult(0, details.tabId).catch((e) => console.warn(LOG_PREFIX, e)); },
  { urls: ADD_PHONE_SEND_URLS },
);

async function onPhoneSendResult(statusCode, tabId) {
  const s = await chrome.storage.session.get(['flowActive', 'smsEnabled']);
  if (!s.flowActive || !s.smsEnabled) return;
  if (statusCode && statusCode >= 200 && statusCode < 400) {
    await addLog('接码：add-phone/send 发送成功，等待短信...', 'ok', 3);
    return;
  }
  await replacePhoneNumber(statusCode, tabId);
}

async function replacePhoneNumber(statusCode, tabId) {
  if (phoneReplacing) return;
  phoneReplacing = true;
  try {
    const s = await chrome.storage.session.get(['flowActive', 'currentActivation', 'phoneReplacements', 'authTabId']);
    if (!s.flowActive) return;
    const config = await getConfig();
    const maxRepl = clampInt(config.smsMaxReplacements, 0, 20, 3);
    const used = Number(s.phoneReplacements) || 0;
    const round = (await getLoop())?.currentRound || 0;

    await addLog(`接码：add-phone/send 失败（${statusCode || '网络错误'}），手机号异常，准备换号（${used}/${maxRepl}）。`, 'warn', 3);
    if (s.currentActivation?.activationId) {
      await Sms.setStatus(config, s.currentActivation.activationId, 8); // 取消坏号
    }

    if (used >= maxRepl) {
      await chrome.storage.session.remove(['currentActivation']);
      await finishRound(round, 'failed', `手机号连续 ${used} 次发送失败，已达换号上限，放弃本轮。`);
      return;
    }

    let num;
    try {
      num = await Sms.getNumber(config);
    } catch (err) {
      await finishRound(round, 'failed', `换号取号失败：${err.message}`);
      return;
    }
    const dial = String(config.smsDialCode || '').replace(/\D/g, '');
    const nationalNumber = dial && num.phoneNumber.startsWith(dial) ? num.phoneNumber.slice(dial.length) : num.phoneNumber;
    await chrome.storage.session.set({
      currentActivation: { activationId: num.activationId, phoneNumber: num.phoneNumber, nationalNumber },
      phoneReplacements: used + 1,
    });
    await addLog(`接码：已换新号 +${num.phoneNumber}（订单 ${num.activationId}），通知页面重填。`, 'ok', 3);

    const tid = s.authTabId || tabId;
    if (tid) chrome.tabs.sendMessage(tid, { type: 'REFILL_PHONE', phoneNumber: num.phoneNumber }).catch(() => {});
  } finally {
    phoneReplacing = false;
  }
}

// ===== 定时器：超时看门狗 + 轮间延迟 =====
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_TIMEOUT) {
    (async () => {
      const loop = await getLoop();
      const s = await chrome.storage.session.get(['watchdogRound']);
      const round = s.watchdogRound;
      if (!loop || !loop.active || !round) return;
      if (loop.finishedRound >= round) return;
      await finishRound(round, 'failed', `超时（${loop.roundTimeoutSec}s）：页面流程未完成，可能登录受阻 / 元素未出现 / 被风控。`);
    })().catch((err) => console.warn(LOG_PREFIX, err));
  } else if (alarm.name === ALARM_NEXT) {
    (async () => {
      const loop = await getLoop();
      const s = await chrome.storage.session.get(['nextRound']);
      if (!loop || !loop.active || !s.nextRound) return;
      await runRound(s.nextRound);
    })().catch((err) => console.warn(LOG_PREFIX, err));
  }
});

// ===== 消息路由 =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'GET_CONFIG':
          sendResponse({ ok: true, config: await getConfig() });
          break;
        case 'SAVE_CONFIG': {
          const payload = {};
          for (const key of CONFIG_KEYS) {
            if (message.config?.[key] !== undefined) payload[key] = message.config[key];
          }
          await chrome.storage.local.set(payload);
          sendResponse({ ok: true });
          break;
        }
        case 'LOAD_GROUPS': {
          const config = await getConfig();
          const groups = await Sub2Api.loadOpenAiGroups(config);
          sendResponse({ ok: true, groups });
          break;
        }
        case 'START_FLOW':
          sendResponse(await startLoop());
          break;
        case 'STOP_FLOW':
          sendResponse(await stopLoop());
          break;
        case 'GET_STATUS': {
          const s = await chrome.storage.session.get(['status', 'flowActive', 'logs', 'currentStep', 'loop']);
          const loop = s.loop || null;
          sendResponse({
            ok: true,
            status: s.status || null,
            flowActive: Boolean(s.flowActive),
            logs: Array.isArray(s.logs) ? s.logs : [],
            currentStep: s.currentStep || 0,
            totalSteps: TOTAL_STEPS,
            loopActive: Boolean(loop?.active),
            results: loop?.results || [],
            currentRound: loop?.currentRound || 0,
            targetCount: loop?.targetCount || 0,
          });
          break;
        }
        case 'REQUEST_PHONE_NUMBER': {
          const config = await getConfig();
          if (!config.smsEnabled) { sendResponse({ ok: false, error: '未启用接码。' }); break; }
          // 幂等：本轮已取号则直接返回，避免重复购买
          const existing = (await chrome.storage.session.get(['currentActivation'])).currentActivation;
          if (existing?.activationId) {
            sendResponse({ ok: true, ...existing, dialCode: config.smsDialCode, countryLabel: config.smsCountryLabel });
            break;
          }
          const num = await Sms.getNumber(config);
          const dial = String(config.smsDialCode || '').replace(/\D/g, '');
          const nationalNumber = dial && num.phoneNumber.startsWith(dial)
            ? num.phoneNumber.slice(dial.length) : num.phoneNumber;
          const activation = { activationId: num.activationId, phoneNumber: num.phoneNumber, nationalNumber };
          await chrome.storage.session.set({ currentActivation: activation, phoneRequested: true });
          await addLog(`接码：已取号 +${num.phoneNumber}（订单 ${num.activationId}）。`, 'ok', 3);
          sendResponse({ ok: true, ...activation, dialCode: config.smsDialCode, countryLabel: config.smsCountryLabel });
          break;
        }
        case 'REQUEST_PHONE_CODE': {
          const config = await getConfig();
          const act = (await chrome.storage.session.get(['currentActivation'])).currentActivation;
          if (!act?.activationId) { sendResponse({ ok: false, error: '尚未取号。' }); break; }
          const timeoutMs = clampInt(config.smsCodeTimeoutSec, 15, 600, 120) * 1000;
          await addLog('接码：等待短信验证码...', 'info', 3);
          try {
            const code = await Sms.pollCode(config, act.activationId, {
              timeoutMs,
              isAborted: async () => !(await chrome.storage.session.get(['flowActive'])).flowActive,
            });
            await addLog(`接码：已收到验证码 ${code}。`, 'ok', 3);
            sendResponse({ ok: true, code });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
          break;
        }
        case 'LOAD_SMS_COUNTRIES': {
          const config = await getConfig();
          try {
            const countries = await Sms.getCountries(config);
            sendResponse({ ok: true, countries, fromFallback: false });
          } catch (err) {
            sendResponse({ ok: true, countries: Sms.FALLBACK_COUNTRIES, fromFallback: true, error: err.message });
          }
          break;
        }
        case 'QUERY_SMS_BALANCE': {
          const config = await getConfig();
          const balance = await Sms.getBalance(config);
          sendResponse({ ok: true, balance });
          break;
        }
        case 'QUERY_SMS_PRICE': {
          const config = await getConfig();
          const { tiers } = await Sms.getPrices(config, config.smsCountry);
          sendResponse({ ok: true, tiers });
          break;
        }
        case 'CONTENT_LOG':
          await addLog(message.message, message.level || 'info', message.step ?? null);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: `未知消息类型：${message?.type}` });
      }
    } catch (err) {
      if (message?.type === 'START_FLOW') {
        await addLog(err.message, 'error').catch(() => {});
        broadcast({ type: 'LOOP_STATE', active: false });
      }
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // 异步响应
});
