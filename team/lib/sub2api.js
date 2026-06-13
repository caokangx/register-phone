// sub2api 管理后台 API —— 移植自 FlowPilot 1.0 background/sub2api-api.js（精简版）。
// 保留 IIFE 模块模式，background.js 通过 importScripts('lib/sub2api.js') 加载。
(function attachSub2Api(root, factory) {
  root.Sub2Api = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createSub2ApiModule() {
  const DEFAULT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
  const DEFAULT_CONCURRENCY = 10;
  const DEFAULT_PRIORITY = 1;
  const DEFAULT_RATE_MULTIPLIER = 1;

  function normalizeString(value = '') {
    return String(value || '').trim();
  }

  // 邮箱随机后缀：前缀 + 任意字符
  function generateRandomSuffix(length = 6) {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let suffix = '';
    for (let i = 0; i < length; i += 1) {
      suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    return suffix;
  }

  function generatePassword(length = 16) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }

  function extractStateFromAuthUrl(authUrl = '') {
    try {
      return new URL(authUrl).searchParams.get('state') || '';
    } catch {
      return '';
    }
  }

  function normalizeRedirectUri(input = DEFAULT_REDIRECT_URI) {
    const withProtocol = /^https?:\/\//i.test(input) ? input : `http://${input}`;
    const parsed = new URL(withProtocol);
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/auth/callback';
    }
    if (parsed.pathname !== '/auth/callback') {
      throw new Error('SUB2API 回调地址必须是 /auth/callback，例如 http://localhost:1455/auth/callback');
    }
    return parsed.toString();
  }

  function getSub2ApiOrigin(rawUrl = '') {
    const sub2apiUrl = normalizeString(rawUrl);
    if (!sub2apiUrl) {
      throw new Error('尚未配置 SUB2API 网址，请先在侧边栏填写。');
    }
    try {
      return new URL(/^https?:\/\//i.test(sub2apiUrl) ? sub2apiUrl : `http://${sub2apiUrl}`).origin;
    } catch {
      throw new Error('SUB2API 网址格式无效，请先在侧边栏检查。');
    }
  }

  function getSub2ApiErrorMessage(payload, responseStatus = 500, path = '') {
    const candidates = [payload?.message, payload?.detail, payload?.error, payload?.reason];
    const message = candidates.map(normalizeString).find(Boolean);
    return message || `SUB2API 请求失败（HTTP ${responseStatus}）：${path}`;
  }

  async function requestJson(origin, path, options = {}) {
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 30000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const token = normalizeString(options.token);
      const response = await fetch(`${origin}${path}`, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'code')) {
        if (Number(payload.code) === 0) {
          return payload.data;
        }
        throw new Error(getSub2ApiErrorMessage(payload, response.status, path));
      }
      if (!response.ok) {
        throw new Error(getSub2ApiErrorMessage(payload, response.status, path));
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`SUB2API 请求超时：${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function loginSub2Api(config = {}, options = {}) {
    const email = normalizeString(config.sub2apiEmail);
    const password = String(config.sub2apiPassword || '');
    const origin = getSub2ApiOrigin(config.sub2apiUrl);
    if (!email) throw new Error('尚未配置 SUB2API 登录邮箱，请先在侧边栏填写。');
    if (!password) throw new Error('尚未配置 SUB2API 登录密码，请先在侧边栏填写。');

    const loginData = await requestJson(origin, '/api/v1/auth/login', {
      method: 'POST',
      timeoutMs: options.timeoutMs,
      body: { email, password },
    });
    const token = normalizeString(loginData?.access_token || loginData?.accessToken);
    if (!token) throw new Error('SUB2API 登录返回缺少 access_token。');
    return { origin, token };
  }

  function normalizeGroupNames(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[\r\n,，;；]+/);
    const seen = new Set();
    const names = [];
    for (const item of source) {
      const name = normalizeString(item);
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
    return names;
  }

  function isOpenAiGroup(item) {
    return !item?.platform || item.platform === 'openai';
  }

  async function fetchAllGroups(origin, token, options = {}) {
    const groups = await requestJson(origin, '/api/v1/admin/groups/all', {
      method: 'GET',
      token,
      timeoutMs: options.timeoutMs,
    });
    return (Array.isArray(groups) ? groups : []).filter(isOpenAiGroup);
  }

  // 给侧边栏多选用：登录后返回全部 openai 分组（name + id）
  async function loadOpenAiGroups(config = {}, options = {}) {
    const { origin, token } = await loginSub2Api(config, options);
    const groups = await fetchAllGroups(origin, token, options);
    return groups.map((g) => ({ id: g.id, name: normalizeString(g.name) })).filter((g) => g.name);
  }

  async function getGroupsByNames(origin, token, groupNames, options = {}) {
    const targetNames = normalizeGroupNames(groupNames);
    if (!targetNames.length) throw new Error('尚未选择任何分组，请先在侧边栏勾选。');
    const groups = await fetchAllGroups(origin, token, options);
    const matched = [];
    const missing = [];
    for (const targetName of targetNames) {
      const normalized = targetName.toLowerCase();
      const group = groups.find((item) => normalizeString(item?.name).toLowerCase() === normalized);
      if (group) matched.push(group);
      else missing.push(targetName);
    }
    if (missing.length) throw new Error(`SUB2API 中未找到以下 openai 分组：${missing.join('、')}。`);
    return matched;
  }

  function normalizeProxyId(value) {
    if (value === undefined || value === null || value === '') return null;
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized <= 0) return null;
    return normalized;
  }

  function buildProxyDisplayName(proxy = {}) {
    const id = normalizeProxyId(proxy.id);
    const name = normalizeString(proxy.name);
    const protocol = normalizeString(proxy.protocol);
    const host = normalizeString(proxy.host);
    const port = proxy.port === undefined || proxy.port === null ? '' : normalizeString(proxy.port);
    const address = protocol && host && port ? `${protocol}://${host}:${port}` : '';
    return [name || '(未命名代理)', id ? `#${id}` : '', address].filter(Boolean).join(' ');
  }

  function isActiveProxy(proxy = {}) {
    const status = normalizeString(proxy.status).toLowerCase();
    return !status || status === 'active';
  }

  async function resolveProxy(origin, token, preference = '', options = {}) {
    const wanted = normalizeString(preference);
    if (!wanted) return null;
    const proxies = await requestJson(origin, '/api/v1/admin/proxies/all?with_count=true', {
      method: 'GET',
      token,
      timeoutMs: options.timeoutMs,
    });
    if (!Array.isArray(proxies)) throw new Error('SUB2API 代理列表返回格式异常。');
    const active = proxies.filter(isActiveProxy).filter((p) => normalizeProxyId(p.id));
    const wantedId = normalizeProxyId(wanted);
    if (wantedId) {
      const byId = active.find((p) => normalizeProxyId(p.id) === wantedId);
      if (byId) return byId;
      throw new Error(`SUB2API 代理 ID “${wanted}”不存在或未启用。`);
    }
    const lower = wanted.toLowerCase();
    const byName = active.filter((p) => normalizeString(p.name).toLowerCase() === lower);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`SUB2API 代理“${wanted}”匹配到多个，请改填代理 ID。`);
    throw new Error(`SUB2API 代理“${wanted}”不存在或未启用。`);
  }

  function buildDraftAccountName(groupName) {
    const prefix = normalizeString(groupName || 'openai')
      .replace(/[^\w一-龥-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'openai';
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
    const random = Math.floor(Math.random() * 9000 + 1000);
    return `${prefix}-${stamp}-${random}`;
  }

  function parseLocalhostCallback(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('捕获到的 localhost OAuth 回调地址格式无效。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('回调 URL 协议不正确。');
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('只接受 localhost / 127.0.0.1 回调地址。');
    if (parsed.pathname !== '/auth/callback') throw new Error('回调 URL 路径必须是 /auth/callback。');
    const code = normalizeString(parsed.searchParams.get('code'));
    const state = normalizeString(parsed.searchParams.get('state'));
    if (!code || !state) throw new Error('回调 URL 中缺少 code 或 state。');
    return { url: parsed.toString(), code, state };
  }

  function buildOpenAiCredentials(exchangeData) {
    const credentials = {};
    const allowedKeys = ['access_token', 'refresh_token', 'id_token', 'expires_at', 'email',
      'chatgpt_account_id', 'chatgpt_user_id', 'organization_id', 'plan_type', 'client_id'];
    for (const key of allowedKeys) {
      const v = exchangeData?.[key];
      if (v !== undefined && v !== null && v !== '') credentials[key] = v;
    }
    if (!credentials.access_token) throw new Error('SUB2API 交换授权码后未返回 access_token。');
    return credentials;
  }

  function buildOpenAiExtra(exchangeData) {
    const extra = {};
    for (const key of ['email', 'name', 'privacy_mode']) {
      const v = exchangeData?.[key];
      if (v !== undefined && v !== null && v !== '') extra[key] = v;
    }
    return Object.keys(extra).length ? extra : undefined;
  }

  // 步骤1：生成 OpenAI 授权链接
  async function generateAuthUrl(config = {}, options = {}) {
    const redirectUri = normalizeRedirectUri(options.redirectUri || DEFAULT_REDIRECT_URI);
    const groupNames = normalizeGroupNames(config.selectedGroupNames);
    const { origin, token } = await loginSub2Api(config, options);
    const groups = await getGroupsByNames(origin, token, groupNames, options);
    const proxy = await resolveProxy(origin, token, config.proxyPreference, options);
    const proxyId = normalizeProxyId(proxy?.id);

    const authRequestBody = { redirect_uri: redirectUri };
    if (proxyId) authRequestBody.proxy_id = proxyId;
    const authData = await requestJson(origin, '/api/v1/admin/openai/generate-auth-url', {
      method: 'POST',
      token,
      timeoutMs: options.timeoutMs,
      body: authRequestBody,
    });

    const oauthUrl = normalizeString(authData?.auth_url || authData?.authUrl);
    const sessionId = normalizeString(authData?.session_id || authData?.sessionId);
    const oauthState = normalizeString(authData?.state || extractStateFromAuthUrl(oauthUrl));
    if (!oauthUrl || !sessionId) throw new Error('SUB2API 未返回完整的 auth_url / session_id。');

    return {
      oauthUrl,
      sessionId,
      oauthState,
      groupIds: groups.map((g) => g.id),
      groupLabel: groups.map((g) => `${g.name}（#${g.id}）`).join('、'),
      proxyId,
      proxyLabel: proxy ? buildProxyDisplayName(proxy) : '',
    };
  }

  // 步骤7：交换授权码 + 建号
  async function exchangeCallback(config = {}, runtime = {}, options = {}) {
    const callback = parseLocalhostCallback(runtime.localhostUrl || '');
    const sessionId = normalizeString(runtime.sessionId);
    const expectedState = normalizeString(runtime.oauthState);
    if (!sessionId) throw new Error('缺少 SUB2API session_id，请重新点击「开始」。');
    if (expectedState && expectedState !== callback.state) {
      throw new Error('回调中的 state 与生成时不一致，请重新点击「开始」。');
    }

    const { origin, token } = await loginSub2Api(config, options);
    const proxyId = normalizeProxyId(runtime.proxyId);

    const exchangeRequestBody = { session_id: sessionId, code: callback.code, state: callback.state };
    if (proxyId) exchangeRequestBody.proxy_id = proxyId;
    const exchangeData = await requestJson(origin, '/api/v1/admin/openai/exchange-code', {
      method: 'POST',
      token,
      timeoutMs: options.timeoutMs,
      body: exchangeRequestBody,
    });

    const credentials = buildOpenAiCredentials(exchangeData);
    const extra = buildOpenAiExtra(exchangeData);
    const resolvedEmail = normalizeString(exchangeData?.email || credentials?.email);

    let groupIds = (Array.isArray(runtime.groupIds) ? runtime.groupIds : [])
      .map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
    if (!groupIds.length) {
      const groups = await getGroupsByNames(origin, token, normalizeGroupNames(config.selectedGroupNames), options);
      groupIds = groups.map((g) => Number(g.id)).filter((id) => Number.isFinite(id) && id > 0);
    }
    if (!groupIds.length) throw new Error('目标分组 ID 无效。');

    const accountName = resolvedEmail || normalizeString(runtime.email) || buildDraftAccountName(groupIds[0]);
    const createPayload = {
      name: accountName,
      notes: '',
      platform: 'openai',
      type: 'oauth',
      credentials,
      concurrency: DEFAULT_CONCURRENCY,
      priority: DEFAULT_PRIORITY,
      rate_multiplier: DEFAULT_RATE_MULTIPLIER,
      group_ids: groupIds,
      auto_pause_on_expired: true,
    };
    if (proxyId) createPayload.proxy_id = proxyId;
    if (extra) createPayload.extra = extra;

    const createdAccount = await requestJson(origin, '/api/v1/admin/accounts', {
      method: 'POST',
      token,
      timeoutMs: options.createTimeoutMs || options.timeoutMs,
      body: createPayload,
    });

    return { accountId: createdAccount?.id || null, accountName, email: resolvedEmail };
  }

  return {
    DEFAULT_REDIRECT_URI,
    generateRandomSuffix,
    generatePassword,
    loadOpenAiGroups,
    generateAuthUrl,
    exchangeCallback,
    parseLocalhostCallback,
  };
});
