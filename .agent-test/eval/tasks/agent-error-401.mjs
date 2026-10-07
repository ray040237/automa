/**
 * 生产 loop：假 key → 401 → 归类到 provider（原 agent-live [4]）。
 *
 * 这条不换 provider，只把 apiKey 换成假值，验的是错误**归类链路**：
 * pi 把失败编码进 assistant 消息（stopReason=error + errorMessage），
 * `classifyPiErrorMessage` 从 errorMessage 里反解出 httpStatus=401、归类 provider。
 * 人话文案由 UI 侧按 errorKind 渲染（AgentTranscript.vue），不在 loop 层 ——
 * 故这里断言 errorKind/httpStatus，不断言中文。
 */
import { AGENT_EVENTS, ERROR_KIND } from '../harness.mjs';

export default {
  id: 'agent/error-401',
  title: '生产 loop：假 key → 401 归类到 provider',
  layer: 'loop',
  async run({ config, makeAgent, check }) {
    const events = [];
    const { agent } = await makeAgent({
      config,
      configOver: { apiKey: 'sk-definitely-invalid' },
    });

    const ret = await agent.send({
      userText: 'hi',
      onEvent: (e) => events.push(e),
    });

    check.hard(
      ret.kind === AGENT_EVENTS.ERROR,
      `预期错误收尾，实得: ${JSON.stringify(ret)}`
    );
    check.hard(
      ret.errorKind === ERROR_KIND.PROVIDER,
      `errorKind 应为 provider，实得: ${ret.errorKind}`
    );
    check.hard(
      ret.httpStatus === 401,
      `httpStatus 应为 401，实得: ${JSON.stringify(ret.httpStatus)}（message: ${String(ret.message).slice(0, 80)}）`
    );
  },
};