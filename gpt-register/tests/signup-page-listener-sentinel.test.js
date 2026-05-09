const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/signup-page.js', 'utf8');

function getListenerBootstrapSource() {
  const end = source.indexOf('async function handleCommand');
  if (end < 0) {
    throw new Error('missing handleCommand marker');
  }
  return source.slice(0, end);
}

test('signup page listener ignores stale DOM sentinels after extension reload', () => {
  const listeners = [];
  const windowRef = {};
  const document = {
    documentElement: {
      getAttribute(name) {
        if (name === 'data-multipage-signup-page-listener') return '1';
        return '';
      },
      setAttribute() {
        throw new Error('listener readiness must not be stored on DOM attributes');
      },
    },
  };
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
    },
  };

  new Function('window', 'document', 'chrome', 'console', 'location', `
${getListenerBootstrapSource()}
`)(windowRef, document, chrome, console, { href: 'https://auth.openai.com/create-account/password' });

  assert.equal(windowRef.__MULTIPAGE_SIGNUP_PAGE_LISTENER_READY__, true);
  assert.equal(listeners.length, 1);
});

test('signup page listener still avoids duplicate registration in one content-script context', () => {
  const listeners = [];
  const windowRef = {};
  const document = {
    documentElement: {
      getAttribute() {
        return '';
      },
      setAttribute() {
        throw new Error('listener readiness must not be stored on DOM attributes');
      },
    },
  };
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
    },
  };
  const runBootstrap = new Function('window', 'document', 'chrome', 'console', 'location', `
${getListenerBootstrapSource()}
`);

  runBootstrap(windowRef, document, chrome, console, { href: 'https://auth.openai.com/create-account/password' });
  runBootstrap(windowRef, document, chrome, console, { href: 'https://auth.openai.com/create-account/password' });

  assert.equal(windowRef.__MULTIPAGE_SIGNUP_PAGE_LISTENER_READY__, true);
  assert.equal(listeners.length, 1);
});
