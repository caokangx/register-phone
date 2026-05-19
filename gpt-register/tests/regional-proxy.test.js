// Tests for the regional (JP / US) proxy feature:
//   - parseHttpProxyAddress  (background/ip-proxy-core.js)
//   - applyRegionalProxy     (background.js)
// The applyRegionalProxy function is loaded by extracting its source from
// background.js (it's a top-level async function) and evaluating it inside a
// vm context with stubbed getState / addLog / applyIpProxySettingsFromState /
// parseHttpProxyAddress, so we can capture the synthetic state the function
// hands to applyIpProxySettingsFromState.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadParser() {
  const providerSource = fs.readFileSync('background/ip-proxy-provider-711proxy.js', 'utf8');
  const coreSource = fs.readFileSync('background/ip-proxy-core.js', 'utf8');
  return new Function(`
const self = {};
const chrome = {};
const DEFAULT_IP_PROXY_SERVICE = '711proxy';
const IP_PROXY_SERVICE_VALUES = ['711proxy'];
const IP_PROXY_ENABLED_SERVICE_VALUES = ['711proxy'];
const DEFAULT_IP_PROXY_MODE = 'account';
const IP_PROXY_MODE_VALUES = ['api', 'account'];
const DEFAULT_IP_PROXY_PROTOCOL = 'http';
const IP_PROXY_PROTOCOL_VALUES = ['http', 'https', 'socks4', 'socks5'];
const IP_PROXY_FETCH_TIMEOUT_MS = 20000;
const IP_PROXY_SETTINGS_SCOPE = 'regular';
const IP_PROXY_BYPASS_LIST = ['<local>', 'localhost', '127.0.0.1'];
const IP_PROXY_ROUTE_ALL_TRAFFIC = true;
const IP_PROXY_FORCE_DIRECT_HOST_PATTERNS = [];
const IP_PROXY_FORCE_DIRECT_FALLBACK = 'PROXY 127.0.0.1:7897';
const IP_PROXY_ACCOUNT_LIST_ENABLED = true;
const IP_PROXY_TARGET_HOST_PATTERNS = ['openai.com'];
${providerSource}
const transformIpProxyAccountEntryByProvider = self.transformIpProxyAccountEntryByProvider;
${coreSource}
return { parseHttpProxyAddress };
`)();
}

function extractApplyRegionalProxySource() {
  const src = fs.readFileSync('background.js', 'utf8');
  const idx = src.indexOf('async function applyRegionalProxy');
  assert.ok(idx >= 0, 'applyRegionalProxy not found in background.js');
  // Brace-balance to find the end of the function.
  const headStart = src.indexOf('{', idx);
  assert.ok(headStart > idx);
  let depth = 0;
  let end = -1;
  for (let i = headStart; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > 0, 'unbalanced braces in applyRegionalProxy');
  return src.slice(idx, end);
}

function loadApplyRegionalProxy(stubs) {
  const fnSource = extractApplyRegionalProxySource();
  const context = {
    getState: stubs.getState,
    addLog: stubs.addLog,
    applyIpProxySettingsFromState: stubs.applyIpProxySettingsFromState,
    parseHttpProxyAddress: stubs.parseHttpProxyAddress,
  };
  vm.createContext(context);
  vm.runInContext(`${fnSource}\nthis.__apply = applyRegionalProxy;`, context);
  return context.__apply;
}

// ----- parseHttpProxyAddress -----

test('parseHttpProxyAddress: bare host:port', () => {
  const { parseHttpProxyAddress } = loadParser();
  assert.deepEqual(parseHttpProxyAddress('http://1.2.3.4:8080'), {
    host: '1.2.3.4',
    port: 8080,
    username: '',
    password: '',
    protocol: 'http',
  });
});

test('parseHttpProxyAddress: URL-style auth (user:pass@host:port) with percent-decoding', () => {
  const { parseHttpProxyAddress } = loadParser();
  assert.deepEqual(parseHttpProxyAddress('http://alice:s%40cret@1.2.3.4:8080'), {
    host: '1.2.3.4',
    port: 8080,
    username: 'alice',
    password: 's@cret',
    protocol: 'http',
  });
});

test('parseHttpProxyAddress: colon-style auth (host:port:user:pass)', () => {
  const { parseHttpProxyAddress } = loadParser();
  assert.deepEqual(parseHttpProxyAddress('http://1.2.3.4:8080:alice:s3cret'), {
    host: '1.2.3.4',
    port: 8080,
    username: 'alice',
    password: 's3cret',
    protocol: 'http',
  });
});

test('parseHttpProxyAddress: colon-style password may contain colons', () => {
  const { parseHttpProxyAddress } = loadParser();
  assert.deepEqual(parseHttpProxyAddress('http://1.2.3.4:8080:alice:pa:ss:word'), {
    host: '1.2.3.4',
    port: 8080,
    username: 'alice',
    password: 'pa:ss:word',
    protocol: 'http',
  });
});

test('parseHttpProxyAddress: hostname (not just IP) works', () => {
  const { parseHttpProxyAddress } = loadParser();
  assert.deepEqual(parseHttpProxyAddress('http://jp-proxy.example.com:8000'), {
    host: 'jp-proxy.example.com',
    port: 8000,
    username: '',
    password: '',
    protocol: 'http',
  });
});

test('parseHttpProxyAddress: https/socks4/socks5 schemes throw', () => {
  const { parseHttpProxyAddress } = loadParser();
  assert.throws(() => parseHttpProxyAddress('https://1.2.3.4:8080'), /http:\/\//);
  assert.throws(() => parseHttpProxyAddress('socks5://1.2.3.4:8080'), /http:\/\//);
  assert.throws(() => parseHttpProxyAddress('socks4://1.2.3.4:8080'), /http:\/\//);
});

test('parseHttpProxyAddress: missing scheme returns null', () => {
  const { parseHttpProxyAddress } = loadParser();
  assert.equal(parseHttpProxyAddress('1.2.3.4:8080'), null);
});

test('parseHttpProxyAddress: empty / whitespace returns null', () => {
  const { parseHttpProxyAddress } = loadParser();
  assert.equal(parseHttpProxyAddress(''), null);
  assert.equal(parseHttpProxyAddress('   '), null);
  assert.equal(parseHttpProxyAddress(null), null);
});

test('parseHttpProxyAddress: missing port returns null', () => {
  const { parseHttpProxyAddress } = loadParser();
  assert.equal(parseHttpProxyAddress('http://1.2.3.4'), null);
});

// ----- applyRegionalProxy -----

const NO_OVERRIDE = Symbol('NO_OVERRIDE');
function makeStubs({ state = {}, parsedOverride = NO_OVERRIDE, parseThrows = null } = {}) {
  const captured = { applyCalls: [], logCalls: [] };
  const stubs = {
    getState: async () => state,
    addLog: async (msg, level) => { captured.logCalls.push({ msg, level }); },
    applyIpProxySettingsFromState: async (synthetic, options) => {
      captured.applyCalls.push({ synthetic, options });
      return { applied: true };
    },
    parseHttpProxyAddress: (raw) => {
      if (parseThrows) throw new Error(parseThrows);
      if (parsedOverride !== NO_OVERRIDE) return parsedOverride;
      // sensible default for happy-path tests
      const m = String(raw || '').match(/^http:\/\/(?:([^:]+):([^@]*)@)?([^:]+):(\d+)$/);
      if (!m) return null;
      return {
        host: m[3],
        port: Number(m[4]),
        username: m[1] || '',
        password: m[2] || '',
        protocol: 'http',
      };
    },
  };
  return { stubs, captured };
}

test('applyRegionalProxy("jp"): happy path constructs synthetic account-mode state and calls applyIpProxySettingsFromState', async () => {
  const { stubs, captured } = makeStubs({
    state: { jpProxyAddress: 'http://alice:secret@1.2.3.4:8080' },
  });
  const applyRegionalProxy = loadApplyRegionalProxy(stubs);

  await applyRegionalProxy('jp');

  assert.equal(captured.applyCalls.length, 1);
  const { synthetic, options } = captured.applyCalls[0];
  assert.equal(synthetic.ipProxyEnabled, true);
  assert.equal(synthetic.ipProxyMode, 'account');
  assert.equal(synthetic.ipProxyAccountList, '');
  assert.equal(synthetic.ipProxyHost, '1.2.3.4');
  assert.equal(synthetic.ipProxyPort, 8080);
  assert.equal(synthetic.ipProxyUsername, 'alice');
  assert.equal(synthetic.ipProxyPassword, 'secret');
  assert.equal(synthetic.ipProxyProtocol, 'http');
  assert.equal(options.forceAuthRebind, true);
  assert.equal(captured.logCalls.length, 1);
  assert.match(captured.logCalls[0].msg, /日本代理/);
  assert.match(captured.logCalls[0].msg, /1\.2\.3\.4:8080/);
});

test('applyRegionalProxy("us"): reads usProxyAddress field, logs 美国代理', async () => {
  const { stubs, captured } = makeStubs({
    state: { usProxyAddress: 'http://10.0.0.1:3128' },
  });
  const applyRegionalProxy = loadApplyRegionalProxy(stubs);

  await applyRegionalProxy('us');

  assert.equal(captured.applyCalls.length, 1);
  assert.equal(captured.applyCalls[0].synthetic.ipProxyHost, '10.0.0.1');
  assert.equal(captured.applyCalls[0].synthetic.ipProxyPort, 3128);
  assert.equal(captured.applyCalls[0].synthetic.ipProxyUsername, '');
  assert.match(captured.logCalls[0].msg, /美国代理/);
});

test('applyRegionalProxy: empty jpProxyAddress throws Chinese error and never calls applyIpProxySettingsFromState', async () => {
  const { stubs, captured } = makeStubs({ state: { jpProxyAddress: '' } });
  const applyRegionalProxy = loadApplyRegionalProxy(stubs);

  await assert.rejects(() => applyRegionalProxy('jp'), /未配置日本代理地址/);
  assert.equal(captured.applyCalls.length, 0);
});

test('applyRegionalProxy: empty usProxyAddress throws Chinese error', async () => {
  const { stubs, captured } = makeStubs({ state: { usProxyAddress: '   ' } });
  const applyRegionalProxy = loadApplyRegionalProxy(stubs);

  await assert.rejects(() => applyRegionalProxy('us'), /未配置美国代理地址/);
  assert.equal(captured.applyCalls.length, 0);
});

test('applyRegionalProxy: unknown region throws', async () => {
  const { stubs } = makeStubs({ state: {} });
  const applyRegionalProxy = loadApplyRegionalProxy(stubs);
  await assert.rejects(() => applyRegionalProxy('eu'), /未知的区域代理标识/);
});

test('applyRegionalProxy: parseHttpProxyAddress throwing surfaces the protocol error', async () => {
  const { stubs } = makeStubs({
    state: { jpProxyAddress: 'socks5://x:1' },
    parseThrows: '代理地址协议必须是 http://（当前为 socks5://）。',
  });
  const applyRegionalProxy = loadApplyRegionalProxy(stubs);
  await assert.rejects(() => applyRegionalProxy('jp'), /代理地址协议必须是 http/);
});

test('applyRegionalProxy: parseHttpProxyAddress returning null surfaces format error', async () => {
  const { stubs } = makeStubs({
    state: { usProxyAddress: 'http://garbage' },
    parsedOverride: null,
  });
  const applyRegionalProxy = loadApplyRegionalProxy(stubs);
  await assert.rejects(() => applyRegionalProxy('us'), /格式不合法/);
});
