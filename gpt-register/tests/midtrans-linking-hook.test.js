const test = require('node:test');
const assert = require('node:assert/strict');

function isMidtransLinkingUrl(absoluteUrl) {
  if (!absoluteUrl) {
    return false;
  }
  try {
    const u = new URL(String(absoluteUrl).split('#')[0], 'https://app.midtrans.com/');
    if (!/^app\.midtrans\.com$/i.test(u.hostname || '')) {
      return false;
    }
    return /\/snap\/v\d+\/accounts\/[^/]+\/linking$/i.test(u.pathname || '');
  } catch (_) {
    return false;
  }
}

test('Midtrans linking URL matcher accepts v3 path with account hash', () => {
  assert.equal(
    isMidtransLinkingUrl('https://app.midtrans.com/snap/v3/accounts/9682f7db-6a9d-4751-87a2-91857ff179e2/linking'),
    true
  );
});

test('Midtrans linking URL matcher accepts v4 and strips hash fragment', () => {
  assert.equal(
    isMidtransLinkingUrl('https://app.midtrans.com/snap/v4/accounts/abc-def-123/linking#foo'),
    true
  );
});

test('Midtrans linking URL matcher rejects non-linking snap paths', () => {
  assert.equal(isMidtransLinkingUrl('https://app.midtrans.com/snap/v3/bin/bin'), false);
  assert.equal(isMidtransLinkingUrl('https://example.com/snap/v3/accounts/x/linking'), false);
});
