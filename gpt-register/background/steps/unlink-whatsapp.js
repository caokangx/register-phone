(function attachBackgroundUnlinkWhatsapp(root, factory) {
  root.MultiPageBackgroundUnlinkWhatsapp = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundUnlinkWhatsappModule() {
  function createUnlinkWhatsappExecutor(deps = {}) {
    const {
      addLog,
      completeStepFromBackground,
      setState,
      whatsappOtpClient,
    } = deps;

    const STEP_ID = 14;

    function isTimeoutError(error) {
      const message = String(error?.message || error || '');
      if (!message) return false;
      return /fetch\s*timeout|abort(?:ed|error)|timed?\s*out|超时/i.test(message);
    }

    async function executeUnlinkWhatsapp(state = {}) {
      if (!whatsappOtpClient) {
        throw new Error(`步骤 ${STEP_ID}：WhatsApp OTP 客户端未初始化，无法调用 /unlink。`);
      }

      await addLog(`步骤 ${STEP_ID}：正在调用 /unlink 取消 WhatsApp 与 OpenAI 的绑定...`, 'info');
      let timedOut = false;
      try {
        await whatsappOtpClient.unlinkWhatsapp(state);
        await addLog(`步骤 ${STEP_ID}：/unlink 调用成功，已断开 WhatsApp 与 OpenAI 的绑定。`, 'ok');
      } catch (err) {
        if (isTimeoutError(err)) {
          timedOut = true;
          await addLog(
            `步骤 ${STEP_ID}：/unlink 请求超时（${err?.message || err}），按成功处理（手机端可能已经完成解绑）。`,
            'warn'
          );
        } else {
          await addLog(`步骤 ${STEP_ID}：/unlink 调用失败：${err?.message || String(err || '')}`, 'error');
          throw err;
        }
      }

      await setState({
        plusWhatsappUnlinkedAt: Date.now(),
      });
      await completeStepFromBackground(STEP_ID, {
        plusWhatsappUnlinkedAt: Date.now(),
        plusWhatsappUnlinkTimedOut: timedOut,
      });
    }

    return {
      executeUnlinkWhatsapp,
    };
  }

  return {
    createUnlinkWhatsappExecutor,
  };
});
