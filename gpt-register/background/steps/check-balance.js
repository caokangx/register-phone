(function attachBackgroundCheckBalance(root, factory) {
  root.MultiPageBackgroundCheckBalance = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundCheckBalanceModule() {
  function createCheckBalanceExecutor(deps = {}) {
    const {
      addLog,
      completeStepFromBackground,
      setState,
      whatsappOtpClient,
    } = deps;

    const STEP_ID = 15;
    const BALANCE_POLL_INTERVAL_MS = 15000;
    const BALANCE_REQUEST_TIMEOUT_MS = 15000;

    async function executeCheckBalance(state = {}) {
      if (!whatsappOtpClient || typeof whatsappOtpClient.pollBalance !== 'function') {
        throw new Error(`步骤 ${STEP_ID}：WhatsApp OTP 客户端未提供 pollBalance 能力。`);
      }

      await addLog(
        `步骤 ${STEP_ID}：开始轮询 /balance，等待账户余额到账（> 0），每 ${Math.round(BALANCE_POLL_INTERVAL_MS / 1000)} 秒一次，单次请求超时 ${Math.round(BALANCE_REQUEST_TIMEOUT_MS / 1000)} 秒，整体无超时（直到到账或用户停止）...`,
        'info'
      );
      const result = await whatsappOtpClient.pollBalance(state, {
        intervalMs: BALANCE_POLL_INTERVAL_MS,
        requestTimeoutMs: BALANCE_REQUEST_TIMEOUT_MS,
        timeoutMs: Infinity,
        stepLabel: `步骤 ${STEP_ID}`,
      });

      await addLog(
        `步骤 ${STEP_ID}：账户余额已到账：${result?.raw || ''}（数值 ${result?.value ?? 'unknown'}），共查询 ${result?.attempts || 0} 次。`,
        'ok'
      );

      await setState({
        plusBalanceRaw: result?.raw || '',
        plusBalanceValue: Number.isFinite(result?.value) ? result.value : null,
        plusBalanceConfirmedAt: Date.now(),
      });
      await completeStepFromBackground(STEP_ID, {
        plusBalanceRaw: result?.raw || '',
        plusBalanceValue: Number.isFinite(result?.value) ? result.value : null,
        plusBalanceConfirmedAt: Date.now(),
      });
    }

    return {
      executeCheckBalance,
    };
  }

  return {
    createCheckBalanceExecutor,
  };
});
