const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background imports step registry and shared step definitions', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /background\/steps\/registry\.js/);
  assert.match(source, /data\/step-definitions\.js/);
  assert.match(source, /MultiPageStepDefinitions\?\.getSteps/);
  assert.match(source, /getStepRegistryForState\(state\)/);
  assert.match(source, /PLUS_PAYPAL_STEP_DEFINITIONS/);
  assert.match(source, /PLUS_GOPAY_STEP_DEFINITIONS/);
  assert.match(source, /plusPayPalStepRegistry/);
  assert.match(source, /plusGoPayStepRegistry/);
  assert.match(source, /normalizePlusPaymentMethod\(state\?\.plusPaymentMethod\) === PLUS_PAYMENT_METHOD_GOPAY/);
  assert.match(source, /activeStepRegistry\.executeStep\(step,\s*\{/);
  assert.match(source, /background\/steps\/create-plus-checkout\.js/);
  assert.match(source, /background\/steps\/fill-plus-checkout\.js/);
  assert.match(source, /background\/steps\/gopay-manual-confirm\.js/);
  assert.match(source, /'plus-checkout-billing': \(state\) => plusCheckoutBillingExecutor\.executePlusCheckoutBilling\(state\)/);
  assert.match(source, /'gopay-subscription-confirm': \(state\) => goPayApproveExecutor\.executeGoPayApprove\(state\)/);
  assert.match(source, /background\/steps\/paypal-approve\.js/);
  assert.match(source, /background\/steps\/gopay-approve\.js/);
  assert.match(source, /background\/steps\/plus-return-confirm\.js/);
});


test('GoPay approve executor receives debugger click and the WhatsApp OTP client', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /createGoPayApproveExecutor\(\{[\s\S]*clickWithDebugger[\s\S]*gopayOtpClient: whatsappOtpClient[\s\S]*\}\)/);
  assert.match(source, /background\/whatsapp-otp\.js/);
  assert.match(source, /MultiPageWhatsappOtpClient\?\.createWhatsappOtpClient/);
});

test('background wires up unlink-whatsapp and check-balance executors', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /background\/steps\/unlink-whatsapp\.js/);
  assert.match(source, /background\/steps\/check-balance\.js/);
  assert.match(source, /MultiPageBackgroundUnlinkWhatsapp\?\.createUnlinkWhatsappExecutor/);
  assert.match(source, /MultiPageBackgroundCheckBalance\?\.createCheckBalanceExecutor/);
  assert.match(source, /'unlink-whatsapp': \(state\) => unlinkWhatsappExecutor\.executeUnlinkWhatsapp\(state\)/);
  assert.match(source, /'check-balance': \(state\) => checkBalanceExecutor\.executeCheckBalance\(state\)/);
});
