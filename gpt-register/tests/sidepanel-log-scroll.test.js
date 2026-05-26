const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  assert.notEqual(start, -1, `missing ${name}`);

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function createLogHarness({ scrollTop, scrollHeight, clientHeight }) {
  const appended = [];
  const logArea = {
    scrollTop,
    scrollHeight,
    clientHeight,
    appendChild(node) {
      appended.push(node);
      this.scrollHeight += 30;
    },
  };
  const document = {
    createElement() {
      return {
        className: '',
        innerHTML: '',
        set textContent(value) {
          this.innerHTML = String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        },
      };
    },
  };

  const api = new Function('document', 'logArea', `
    const LOG_AUTO_SCROLL_THRESHOLD_PX = 24;
    const DISPLAY_TIMEZONE = 'Asia/Shanghai';
    const LOG_LEVEL_LABELS = { info: '信息' };
    ${extractFunction('isLogAreaNearBottom')}
    ${extractFunction('escapeHtml')}
    ${extractFunction('appendLog')}
    return { appendLog, isLogAreaNearBottom };
  `)(document, logArea);

  return { api, appended, logArea };
}

test('log panel auto-scrolls only when already near the bottom', () => {
  const atBottom = createLogHarness({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 });
  atBottom.api.appendLog({ timestamp: 0, level: 'info', message: 'new log' });
  assert.equal(atBottom.logArea.scrollTop, 1030);

  const nearBottom = createLogHarness({ scrollTop: 780, scrollHeight: 1000, clientHeight: 200 });
  nearBottom.api.appendLog({ timestamp: 0, level: 'info', message: 'new log' });
  assert.equal(nearBottom.logArea.scrollTop, 1030);

  const scrolledUp = createLogHarness({ scrollTop: 500, scrollHeight: 1000, clientHeight: 200 });
  scrolledUp.api.appendLog({ timestamp: 0, level: 'info', message: 'new log' });
  assert.equal(scrolledUp.logArea.scrollTop, 500);
  assert.equal(scrolledUp.appended.length, 1);
});
