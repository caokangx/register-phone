const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sidepanelSource = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

test('sidepanel only auto-scrolls log when viewport is pinned to bottom', () => {
  assert.match(sidepanelSource, /function isLogPinnedToBottom\(/);
  const appendIdx = sidepanelSource.indexOf('function appendLog(');
  assert.ok(appendIdx >= 0);
  const snippet = sidepanelSource.slice(appendIdx, appendIdx + 1200);
  assert.match(snippet, /const shouldStickToBottom = isLogPinnedToBottom\(\)/);
  assert.match(snippet, /logArea\.appendChild\(line\)/);
  assert.ok(snippet.indexOf('shouldStickToBottom') < snippet.indexOf('logArea.appendChild'));
  assert.match(snippet, /if \(shouldStickToBottom\) \{\s*\n\s*logArea\.scrollTop = logArea\.scrollHeight/);
});
