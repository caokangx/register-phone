const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = ['sub2apiUrl', 'sub2apiEmail', 'sub2apiPassword', 'proxyPreference', 'emailPrefix', 'emailDomain',
  'loopCount', 'roundTimeoutSec', 'loopDelaySec',
  'smsApiKey', 'smsBaseUrl', 'smsCodeTimeoutSec', 'smsDialCode', 'smsMinPrice', 'smsMaxPrice', 'smsMaxReplacements'];

// 内置常用国家（首次渲染/拉取失败时用，与 lib/sms.js 一致）
const BUILTIN_COUNTRIES = [
  { id: 52, label: '泰国 (Thailand)', dial: '66' },
  { id: 6, label: '印度尼西亚 (Indonesia)', dial: '62' },
  { id: 10, label: '越南 (Vietnam)', dial: '84' },
  { id: 16, label: '英国 (United Kingdom)', dial: '44' },
  { id: 151, label: '日本 (Japan)', dial: '81' },
  { id: 43, label: '德国 (Germany)', dial: '49' },
  { id: 73, label: '法国 (France)', dial: '33' },
  { id: 187, label: '美国 (USA)', dial: '1' },
];

function populateCountrySelect(items, selectedId, selectedLabel) {
  const sel = $('smsCountrySelect');
  sel.innerHTML = '';
  let matched = false;
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = String(it.id);
    opt.textContent = it.label;
    opt.dataset.dial = it.dial || '';
    if (String(it.id) === String(selectedId)) { opt.selected = true; matched = true; }
    sel.appendChild(opt);
  }
  // 保存的国家不在列表里时，补一个选项以保留选择
  if (!matched && selectedId) {
    const opt = document.createElement('option');
    opt.value = String(selectedId);
    opt.textContent = selectedLabel || `Country #${selectedId}`;
    opt.selected = true;
    sel.appendChild(opt);
  }
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function renderGroups(names, selectedSet) {
  const list = $('groupList');
  list.innerHTML = '';
  const unique = [...new Set(names.filter(Boolean))];
  if (!unique.length) {
    list.innerHTML = '<span class="muted">点「加载分组」从 SUB2API 拉取</span>';
    return;
  }
  for (const name of unique) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    cb.checked = selectedSet.has(name);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(name));
    list.appendChild(label);
  }
}

function getSelectedGroups() {
  return [...$('groupList').querySelectorAll('input[type="checkbox"]')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);
}

function getRenderedGroupNames() {
  return [...$('groupList').querySelectorAll('input[type="checkbox"]')].map((cb) => cb.value);
}

function collectConfig() {
  const config = {};
  for (const f of TEXT_FIELDS) config[f] = $(f).value.trim();
  config.selectedGroupNames = getSelectedGroups();
  config.smsEnabled = $('smsEnabled').checked;
  const sel = $('smsCountrySelect');
  const opt = sel.options[sel.selectedIndex];
  config.smsCountry = sel.value || '';
  config.smsCountryLabel = opt ? opt.textContent : '';
  config.smsFixedPrice = $('smsFixedPrice').checked;
  return config;
}

// 格式化多档位价格，应用价格区间过滤（参考 flowpilot 输出）
function fmtPrice(p) {
  return (Math.round(Number(p) * 10000) / 10000).toFixed(4).replace(/\.?0+$/, '');
}
function formatTiers(tiers, minStr, maxStr) {
  const min = Number(minStr); const max = Number(maxStr);
  const hasMin = Number.isFinite(min) && min > 0;
  const hasMax = Number.isFinite(max) && max > 0;
  const all = (tiers || []).map((t) => ({ price: Number(t.price), count: Math.max(0, Number(t.count) || 0) }))
    .filter((t) => Number.isFinite(t.price) && t.price > 0)
    .sort((a, b) => a.price - b.price);
  if (!all.length) return '无可用价格档位';
  const within = all.filter((t) => (!hasMin || t.price >= min) && (!hasMax || t.price <= max));
  const shown = within.length ? within : all;
  const limit = 16;
  const tierStr = shown.slice(0, limit).map((t) => `${fmtPrice(t.price)}(x${t.count})`).join(', ')
    + (shown.length > limit ? ` ... +${shown.length - limit} 档` : '');
  const inStock = within.filter((t) => t.count > 0);
  if (!inStock.length) {
    if ((hasMin || hasMax) && !within.length) return `区间内无号源（${hasMin ? fmtPrice(min) : ''}~${hasMax ? fmtPrice(max) : ''}）；全部档位：${all.slice(0, limit).map((t) => `${fmtPrice(t.price)}(x${t.count})`).join(', ')}`;
    return `全档位均无库存；档位：${tierStr}`;
  }
  const label = (hasMin || hasMax) ? '区间内最低' : '最低';
  return `${label} ${fmtPrice(inStock[0].price)}；档位：${tierStr}`;
}

function syncSmsFields() {
  $('smsFields').classList.toggle('disabled', !$('smsEnabled').checked);
}

const TOTAL_STEPS = 7;
const LEVEL_LABELS = { info: 'INFO', ok: '完成', warn: '警告', error: '错误' };

function showStatus(status) {
  if (!status) return;
  const el = $('status');
  el.textContent = status.message || '';
  el.className = `status ${status.level || 'info'}`;
}

function appendLog(entry) {
  if (!entry) return;
  const area = $('logArea');
  const time = new Date(entry.timestamp || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  const level = entry.level || 'info';
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  const stepTag = entry.step ? `<span class="log-step">步${entry.step}</span>` : '';
  line.innerHTML = `<span class="log-time">${time}</span>`
    + `<span class="log-level">${LEVEL_LABELS[level] || level}</span>`
    + stepTag
    + `<span class="log-msg"></span>`;
  line.querySelector('.log-msg').textContent = entry.message || '';
  area.appendChild(line);
  area.scrollTop = area.scrollHeight;
}

function renderResults(results) {
  const area = $('resultsArea');
  if (!results || !results.length) {
    area.innerHTML = '<span class="muted">暂无结果</span>';
    $('resultsSummary').textContent = '尚未运行';
    return;
  }
  area.innerHTML = '';
  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'result-row';
    const badge = r.status === 'success' ? '成功' : '失败';
    const detail = r.status === 'success'
      ? `账号 #${r.accountId || '?'}　${r.email || ''}`
      : (r.reason || '未知原因');
    row.innerHTML = `<span class="result-round">第${r.round}轮</span>`
      + `<span class="result-badge ${r.status}">${badge}</span>`
      + `<span class="result-detail"></span>`;
    row.querySelector('.result-detail').textContent = detail;
    area.appendChild(row);
  }
  area.scrollTop = area.scrollHeight;
  const ok = results.filter((r) => r.status === 'success').length;
  $('resultsSummary').textContent = `共 ${results.length} 轮 · 成功 ${ok} · 失败 ${results.length - ok}`;
}

function updateStepProgress(currentStep, total = TOTAL_STEPS) {
  const step = Math.max(0, Math.min(total, Number(currentStep) || 0));
  $('stepProgress').textContent = `${step} / ${total}`;
  const bar = $('stepBar');
  bar.innerHTML = '';
  for (let i = 1; i <= total; i += 1) {
    const seg = document.createElement('div');
    seg.className = 'seg' + (i < step ? ' done' : i === step ? ' active' : '');
    bar.appendChild(seg);
  }
}

async function init() {
  const res = await send({ type: 'GET_CONFIG' });
  const config = res?.config || {};
  for (const f of TEXT_FIELDS) $(f).value = config[f] || '';
  $('smsEnabled').checked = Boolean(config.smsEnabled);
  $('smsFixedPrice').checked = Boolean(config.smsFixedPrice);
  populateCountrySelect(BUILTIN_COUNTRIES, config.smsCountry || '52', config.smsCountryLabel);
  syncSmsFields();
  const selected = Array.isArray(config.selectedGroupNames) ? config.selectedGroupNames : [];
  renderGroups(selected, new Set(selected));

  const st = await send({ type: 'GET_STATUS' });
  if (st?.status) showStatus(st.status);
  $('logArea').innerHTML = '';
  for (const entry of st?.logs || []) appendLog(entry);
  updateStepProgress(st?.currentStep || 0, st?.totalSteps || TOTAL_STEPS);
  renderResults(st?.results || []);
  setRunning(Boolean(st?.loopActive));
}

function setRunning(running) {
  $('btnStart').disabled = running;
  $('btnStart').textContent = running ? '运行中...' : '开始';
}

$('smsEnabled').addEventListener('change', syncSmsFields);

// 选国家时自动带出区号
$('smsCountrySelect').addEventListener('change', () => {
  const sel = $('smsCountrySelect');
  const dial = sel.options[sel.selectedIndex]?.dataset.dial || '';
  if (dial) $('smsDialCode').value = dial;
});

$('btnLoadCountries').addEventListener('click', async () => {
  await send({ type: 'SAVE_CONFIG', config: collectConfig() });
  $('smsBalance').textContent = '正在加载国家列表...';
  const res = await send({ type: 'LOAD_SMS_COUNTRIES' });
  $('smsBalance').textContent = '余额未查询';
  if (!res?.ok) { showStatus({ message: `加载国家失败：${res?.error || '未知错误'}`, level: 'error' }); return; }
  const sel = $('smsCountrySelect');
  const cur = sel.value;
  const curLabel = sel.options[sel.selectedIndex]?.textContent || '';
  populateCountrySelect(res.countries, cur, curLabel);
  showStatus({ message: res.fromFallback ? `在线列表加载失败，已用内置 ${res.countries.length} 国（${res.error || ''}）` : `已加载 ${res.countries.length} 个国家。`, level: res.fromFallback ? 'warn' : 'ok' });
});

$('btnQueryBalance').addEventListener('click', async () => {
  await send({ type: 'SAVE_CONFIG', config: collectConfig() });
  $('smsBalance').textContent = '查询中...';
  const res = await send({ type: 'QUERY_SMS_BALANCE' });
  $('smsBalance').textContent = res?.ok ? `HeroSMS 余额 ${res.balance}` : `查询失败：${res?.error || '未知错误'}`;
});

$('btnQueryPrice').addEventListener('click', async () => {
  await send({ type: 'SAVE_CONFIG', config: collectConfig() });
  $('smsPrice').textContent = '查询中...';
  const res = await send({ type: 'QUERY_SMS_PRICE' });
  if (!res?.ok) { $('smsPrice').textContent = `查询失败：${res?.error || '未知错误'}`; return; }
  const label = $('smsCountrySelect').options[$('smsCountrySelect').selectedIndex]?.textContent || '';
  $('smsPrice').textContent = `${label}: ${formatTiers(res.tiers, $('smsMinPrice').value, $('smsMaxPrice').value)}`;
});

$('btnSave').addEventListener('click', async () => {
  await send({ type: 'SAVE_CONFIG', config: collectConfig() });
  showStatus({ message: '配置已保存。', level: 'ok' });
});

$('btnLoadGroups').addEventListener('click', async () => {
  // 先保存当前文本配置，保证拉分组用的是最新登录信息
  await send({ type: 'SAVE_CONFIG', config: collectConfig() });
  showStatus({ message: '正在加载分组...', level: 'info' });
  const res = await send({ type: 'LOAD_GROUPS' });
  if (!res?.ok) {
    showStatus({ message: `加载分组失败：${res?.error || '未知错误'}`, level: 'error' });
    return;
  }
  const fetched = res.groups.map((g) => g.name);
  const selected = new Set(getSelectedGroups());
  renderGroups([...fetched, ...getRenderedGroupNames()], selected);
  showStatus({ message: `已加载 ${fetched.length} 个分组。`, level: 'ok' });
});

$('btnStart').addEventListener('click', async () => {
  await send({ type: 'SAVE_CONFIG', config: collectConfig() });
  showStatus({ message: '正在启动...', level: 'info' });
  setRunning(true);
  renderResults([]);
  const res = await send({ type: 'START_FLOW' });
  if (!res?.ok) {
    showStatus({ message: `启动失败：${res?.error || '未知错误'}`, level: 'error' });
    setRunning(false);
  }
});

$('btnStop').addEventListener('click', async () => {
  await send({ type: 'STOP_FLOW' });
  setRunning(false);
});

$('btnClearLog').addEventListener('click', () => {
  $('logArea').innerHTML = '';
});

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case 'LOG':
      appendLog(message.entry);
      showStatus(message.entry);
      if (message.currentStep !== undefined) {
        updateStepProgress(message.currentStep, message.totalSteps || TOTAL_STEPS);
      }
      break;
    case 'ROUND_RESULT':
      renderResults(message.results);
      break;
    case 'LOOP_DONE':
      renderResults(message.results);
      setRunning(false);
      break;
    case 'LOOP_STATE':
      setRunning(Boolean(message.active));
      break;
    default:
      break;
  }
});

init();
