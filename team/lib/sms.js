// 接码（HeroSMS / sms-activate 风格）—— 移植自 flowpilot phone-verification-flow.js 的核心机制（精简版）。
// API：GET https://hero-sms.com/stubs/handler_api.php?api_key=KEY&action=...
//  - getNumber&service=dr&country=52        → ACCESS_NUMBER:<id>:<phone>
//  - getStatus&id=<id>                      → STATUS_WAIT_CODE | STATUS_OK:<code>
//  - setStatus&id=<id>&status=6|8           → 6 完成 / 8 取消
(function attachSms(root, factory) {
  root.Sms = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createSmsModule() {
  const DEFAULT_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';
  const DEFAULT_SERVICE = 'dr';   // OpenAI
  const DEFAULT_COUNTRY = '52';   // Thailand
  const REQUEST_TIMEOUT_MS = 20000;

  // 国家ID → 国际区号（用于自动推算本地号段；HeroSMS getCountries 不返回区号）
  const DIAL_BY_ID = { 6: '62', 10: '84', 16: '44', 43: '49', 52: '66', 73: '33', 151: '81', 187: '1' };
  // 内置常用国家（getCountries 拉取失败时回退）
  const FALLBACK_COUNTRIES = [
    { id: 52, label: '泰国 (Thailand)', dial: '66' },
    { id: 6, label: '印度尼西亚 (Indonesia)', dial: '62' },
    { id: 10, label: '越南 (Vietnam)', dial: '84' },
    { id: 16, label: '英国 (United Kingdom)', dial: '44' },
    { id: 151, label: '日本 (Japan)', dial: '81' },
    { id: 43, label: '德国 (Germany)', dial: '49' },
    { id: 73, label: '法国 (France)', dial: '33' },
    { id: 187, label: '美国 (USA)', dial: '1' },
  ];

  function s(v) { return String(v || '').trim(); }

  function buildUrl(baseUrl, query) {
    const url = new URL(s(baseUrl) || DEFAULT_BASE_URL);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async function request(config, query, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(buildUrl(config.smsBaseUrl, { api_key: config.smsApiKey, ...query }), {
        method: 'GET',
        signal: controller.signal,
      });
      const text = (await resp.text()).trim();
      if (!resp.ok) throw new Error(`${label} 失败（HTTP ${resp.status}）：${text || '无响应'}`);
      // 常见错误码
      if (/^(BAD_KEY|ERROR_NO_KEY|BAD_ACTION|ERROR_SQL|BANNED)/i.test(text)) {
        throw new Error(`${label} 失败：${text}`);
      }
      return text;
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error(`${label} 超时。`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // 从短信文本中提取验证码（4-8 位数字，取最后一段）
  function extractCode(text) {
    const matches = s(text).match(/\d{4,8}/g);
    return matches ? matches[matches.length - 1] : '';
  }

  // 取号：返回 { activationId, phoneNumber }（phoneNumber 为国际区号开头的纯数字，如 66XXXXXXXXX）
  // 支持价格上限（maxPrice）与指定挡位（fixedPrice：精确按 maxPrice 这一档取号）
  async function getNumber(config) {
    if (!s(config.smsApiKey)) throw new Error('未配置接码 API Key。');
    const query = {
      action: 'getNumber',
      service: DEFAULT_SERVICE, // HeroSMS OpenAI 固定为 dr（与 flowpilot 一致）
      country: s(config.smsCountry) || DEFAULT_COUNTRY,
    };
    const maxPrice = Number(config.smsMaxPrice);
    if (Number.isFinite(maxPrice) && maxPrice > 0) {
      query.maxPrice = maxPrice;
      if (config.smsFixedPrice) query.fixedPrice = 'true';
    }
    const text = await request(config, query, '接码取号');
    const m = text.match(/^ACCESS_NUMBER:([^:]+):(.+)$/i);
    if (!m) {
      if (/^NO_NUMBERS/i.test(text)) throw new Error('接码取号失败：当前无可用号码（NO_NUMBERS）。');
      if (/^NO_BALANCE/i.test(text)) throw new Error('接码取号失败：余额不足（NO_BALANCE）。');
      throw new Error(`接码取号失败：${text}`);
    }
    return { activationId: s(m[1]), phoneNumber: s(m[2]).replace(/^\+/, '') };
  }

  // 轮询验证码：直到 STATUS_OK:code 或超时
  async function pollCode(config, activationId, options = {}) {
    const timeoutMs = Math.max(15000, Number(options.timeoutMs) || 120000);
    const intervalMs = Math.max(2000, Number(options.intervalMs) || 5000);
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      if (typeof options.isAborted === 'function' && await options.isAborted()) {
        throw new Error('接码已取消。');
      }
      const text = await request(config, { action: 'getStatus', id: activationId }, '接码查码');
      last = text;
      const ok = text.match(/^STATUS_OK:(.+)$/i);
      if (ok) {
        const code = extractCode(ok[1]);
        if (code) return code;
      }
      if (/^STATUS_CANCEL/i.test(text)) throw new Error('接码订单已被取消（STATUS_CANCEL）。');
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`等待短信验证码超时。最后状态：${last || '无'}`);
  }

  // 设置状态：6=完成（号码可复用/结算），8=取消
  async function setStatus(config, activationId, status) {
    if (!s(activationId)) return '';
    try {
      return await request(config, { action: 'setStatus', id: activationId, status }, '接码设状态');
    } catch {
      return '';
    }
  }

  function buildCountryLabel(c) {
    const eng = s(c?.eng);
    const chn = s(c?.chn);
    if (chn && eng) return chn.toLowerCase() === eng.toLowerCase() ? eng : `${chn} (${eng})`;
    return chn || eng;
  }

  // 拉取 HeroSMS 国家列表（getCountries 无需 api_key）→ [{id, label, dial}]
  async function getCountries(config) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(buildUrl(config.smsBaseUrl, { action: 'getCountries' }), {
        method: 'GET', cache: 'no-store', signal: controller.signal,
      });
      const text = await resp.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch { payload = null; }
      let list = [];
      if (Array.isArray(payload?.value)) list = payload.value;
      else if (Array.isArray(payload)) list = payload;
      else if (payload && typeof payload === 'object') list = Object.values(payload).filter((e) => e && typeof e === 'object');
      const items = list
        .filter((c) => Number(c?.id) > 0 && (s(c?.eng) || s(c?.chn)))
        .map((c) => {
          const id = Number(c.id);
          return { id, label: buildCountryLabel(c) || `Country #${id}`, dial: DIAL_BY_ID[id] || '' };
        })
        .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
      if (!items.length) throw new Error('国家列表为空');
      return items;
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('拉取国家列表超时。');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // 查余额 → 数字字符串
  async function getBalance(config) {
    if (!s(config.smsApiKey)) throw new Error('未配置接码 API Key。');
    const text = await request(config, { action: 'getBalance' }, '查余额');
    const m = text.match(/ACCESS_BALANCE:([\d.]+)/i);
    if (!m) throw new Error(`查余额失败：${text}`);
    return m[1];
  }

  function normPrice(v) {
    const direct = Number(v);
    if (Number.isFinite(direct) && direct >= 0) return direct;
    const m = String(v ?? '').trim().match(/-?\d+(?:[.,]\d+)?/);
    if (!m) return null;
    const p = Number(String(m[0]).replace(',', '.'));
    return Number.isFinite(p) && p >= 0 ? p : null;
  }

  // 解析服务节点中的全部价格档位 → [{ price, count }]（升序，按价格去重取最大库存）
  // 兼容：{cost,count}、{priceMap}、{freePriceMap}、{ "<price>": count }、{ "<price>": {count} }
  function parseTierNode(node) {
    const out = [];
    if (!node || typeof node !== 'object') return out;
    if (Number.isFinite(Number(node.cost))) {
      out.push({ price: Number(node.cost), count: Number(node.count ?? node.physicalCount) || 0 });
    }
    for (const mapKey of ['priceMap', 'freePriceMap']) {
      const m = node[mapKey];
      if (m && typeof m === 'object') {
        for (const [p, c] of Object.entries(m)) {
          const price = normPrice(p);
          if (price !== null && price > 0) out.push({ price, count: Number(c) || 0 });
        }
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (['cost', 'count', 'physicalCount', 'priceMap', 'freePriceMap'].includes(k)) continue;
      const price = normPrice(k);
      if (price === null || price <= 0) continue;
      let count = 0;
      if (v && typeof v === 'object') count = Number(v.count ?? v.physicalCount ?? v.stock ?? v.available ?? v.qty) || 0;
      else count = Number(v) || 0;
      out.push({ price, count });
    }
    const byPrice = new Map();
    for (const t of out) {
      const price = Math.round(t.price * 10000) / 10000;
      const prev = byPrice.get(price);
      byPrice.set(price, prev === undefined ? t.count : Math.max(prev, t.count));
    }
    return [...byPrice.entries()].map(([price, count]) => ({ price, count })).sort((a, b) => a.price - b.price);
  }

  // 查价格（多档位）→ { tiers: [{price, count}] }
  async function getPrices(config, countryId) {
    if (!s(config.smsApiKey)) throw new Error('未配置接码 API Key。');
    const service = DEFAULT_SERVICE; // 固定 dr（OpenAI）
    const cid = s(countryId) || DEFAULT_COUNTRY;
    // 合并 getPrices 与 getPricesExtended 两个接口的档位，覆盖更全
    const merged = [];
    for (const action of ['getPrices', 'getPricesExtended']) {
      let text;
      try {
        text = await request(config, { action, service, country: cid }, '查价格');
      } catch { continue; }
      let payload = null;
      try { payload = JSON.parse(text); } catch { continue; }
      const node = payload?.[String(cid)]?.[service] ?? payload?.[cid]?.[service];
      merged.push(...parseTierNode(node));
    }
    const byPrice = new Map();
    for (const t of merged) {
      const price = Math.round(t.price * 10000) / 10000;
      const prev = byPrice.get(price);
      byPrice.set(price, prev === undefined ? t.count : Math.max(prev, t.count));
    }
    const tiers = [...byPrice.entries()].map(([price, count]) => ({ price, count })).sort((a, b) => a.price - b.price);
    if (!tiers.length) throw new Error('该国家/服务暂无价格档位。');
    return { tiers };
  }

  return {
    getNumber, pollCode, setStatus, extractCode,
    getCountries, getBalance, getPrices,
    DEFAULT_BASE_URL, DEFAULT_SERVICE, DEFAULT_COUNTRY, FALLBACK_COUNTRIES, DIAL_BY_ID,
  };
});
