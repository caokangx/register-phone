const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('shared/flow-capabilities.js', 'utf8');

function loadApi() {
  const scope = {};
  return new Function('self', `${source}; return self.MultiPageFlowCapabilities;`)(scope);
}

test('flow capability registry keeps OpenAI phone signup available even alongside Plus mode, gated only by phone verification and contribution mode', () => {
  const api = loadApi();
  const registry = api.createFlowCapabilityRegistry();

  const enabledState = registry.resolveSidepanelCapabilities({
    state: {
      activeFlowId: 'openai',
      panelMode: 'cpa',
      phoneVerificationEnabled: true,
      plusModeEnabled: false,
      contributionMode: false,
      signupMethod: 'phone',
    },
  });

  assert.equal(enabledState.canUsePhoneSignup, true);
  assert.equal(enabledState.effectiveSignupMethod, 'phone');
  assert.equal(enabledState.shouldWarnCpaPhoneSignup, true);
  assert.deepEqual(enabledState.effectiveSignupMethods, ['email', 'phone']);

  const plusWithPhoneState = registry.resolveSidepanelCapabilities({
    state: {
      activeFlowId: 'openai',
      panelMode: 'sub2api',
      phoneVerificationEnabled: true,
      plusModeEnabled: true,
      contributionMode: false,
      signupMethod: 'phone',
    },
  });

  assert.equal(plusWithPhoneState.canUsePhoneSignup, true);
  assert.equal(plusWithPhoneState.effectiveSignupMethod, 'phone');
  assert.deepEqual(plusWithPhoneState.effectiveSignupMethods, ['email', 'phone']);

  const contributionLockedState = registry.resolveSidepanelCapabilities({
    state: {
      activeFlowId: 'openai',
      panelMode: 'sub2api',
      phoneVerificationEnabled: true,
      plusModeEnabled: false,
      contributionMode: true,
      signupMethod: 'phone',
    },
  });

  assert.equal(contributionLockedState.canUsePhoneSignup, false);
  assert.equal(contributionLockedState.effectiveSignupMethod, 'email');
  assert.deepEqual(contributionLockedState.effectiveSignupMethods, ['email']);
});

test('flow capability registry defaults unknown flows to minimal non-phone capabilities', () => {
  const api = loadApi();
  const registry = api.createFlowCapabilityRegistry();

  const capabilityState = registry.resolveSidepanelCapabilities({
    state: {
      activeFlowId: 'site-a',
      panelMode: 'codex2api',
      phoneVerificationEnabled: true,
      plusModeEnabled: true,
      contributionMode: true,
      signupMethod: 'phone',
    },
  });

  assert.equal(capabilityState.activeFlowId, 'site-a');
  assert.equal(capabilityState.canShowPhoneSettings, false);
  assert.equal(capabilityState.canShowPlusSettings, false);
  assert.equal(capabilityState.canShowLuckmail, false);
  assert.equal(capabilityState.canUsePhoneSignup, false);
  assert.equal(capabilityState.effectiveSignupMethod, 'email');
  assert.equal(capabilityState.panelMode, 'codex2api');
  assert.deepEqual(capabilityState.supportedPanelModes, []);
});

test('flow capability registry exposes shared auto-run validation for phone locks and panel support', () => {
  const api = loadApi();
  const registry = api.createFlowCapabilityRegistry({
    flowCapabilities: {
      openai: api.FLOW_CAPABILITIES.openai,
      'site-a': {
        ...api.DEFAULT_FLOW_CAPABILITIES,
        supportsPlatformBinding: ['cpa'],
      },
    },
  });

  const plusAllowedResult = registry.validateAutoRunStart({
    state: {
      activeFlowId: 'openai',
      panelMode: 'cpa',
      signupMethod: 'phone',
      phoneVerificationEnabled: true,
      plusModeEnabled: true,
      contributionMode: false,
    },
  });

  assert.equal(plusAllowedResult.ok, true, '手机号注册在 Plus 模式下应当被允许');

  const contributionLockedResult = registry.validateAutoRunStart({
    state: {
      activeFlowId: 'openai',
      panelMode: 'cpa',
      signupMethod: 'phone',
      phoneVerificationEnabled: true,
      plusModeEnabled: false,
      contributionMode: true,
    },
  });

  assert.equal(contributionLockedResult.ok, false);
  assert.equal(contributionLockedResult.errors[0].code, 'phone_signup_contribution_mode_locked');

  const unsupportedPanelResult = registry.validateAutoRunStart({
    state: {
      activeFlowId: 'site-a',
      panelMode: 'sub2api',
      signupMethod: 'email',
    },
  });

  assert.equal(unsupportedPanelResult.ok, false);
  assert.equal(unsupportedPanelResult.errors[0].code, 'panel_mode_unsupported');
});

test('flow capability registry normalizes unsupported mode switches back to the effective capability set', () => {
  const api = loadApi();
  const registry = api.createFlowCapabilityRegistry({
    flowCapabilities: {
      openai: api.FLOW_CAPABILITIES.openai,
      'site-a': {
        ...api.DEFAULT_FLOW_CAPABILITIES,
        supportsPlatformBinding: ['cpa'],
      },
    },
  });

  const validation = registry.validateModeSwitch({
    state: {
      activeFlowId: 'site-a',
      panelMode: 'sub2api',
      signupMethod: 'phone',
      phoneVerificationEnabled: true,
      plusModeEnabled: true,
      contributionMode: true,
    },
    changedKeys: [
      'panelMode',
      'signupMethod',
      'phoneVerificationEnabled',
      'plusModeEnabled',
      'contributionMode',
    ],
  });

  assert.equal(validation.ok, false);
  assert.deepEqual(validation.normalizedUpdates, {
    panelMode: 'cpa',
    signupMethod: 'email',
    phoneVerificationEnabled: false,
    plusModeEnabled: false,
    contributionMode: false,
  });
  assert.deepEqual(
    validation.errors.map((entry) => entry.code),
    [
      'panel_mode_unsupported',
      'plus_mode_unsupported',
      'contribution_mode_unsupported',
      'phone_verification_unsupported',
      'phone_signup_flow_unsupported',
    ]
  );
});
