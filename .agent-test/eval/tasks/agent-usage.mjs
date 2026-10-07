/**
 * 生产 loop：网关是否回传 usage（原 live-p3 [1]）。
 *
 * ModelScope 免费额度下网关「有时回传、有时不回」—— 不回传是预期降级
 * （面板用量显示为空），故记 SKIP 而非 FAIL。
 *
 * 观察通道已随 ADR 0004 改变：旧的 `chunk.type === 'usage'` 流事件没有了
 * （provider 层归 pi）。现在从 pi 流收尾产出的 AssistantMessage 上读 `.usage`
 * —— 与 `loop.js` 的 `harvestUsage` 同源（那条也是读 `m.usage.input/output`）。
 */
export default {
  id: 'agent/usage',
  title: '生产 loop：usage 回传（网关可选，缺失记 SKIP）',
  layer: 'loop',
  async run({ config, createPiProvider, toPiContext, check, skipIfRateLimited }) {
    const { model, streamFn } = await createPiProvider(config);
    const stream = streamFn(
      model,
      toPiContext([{ role: 'user', content: '用一句话回答:天空是什么颜色?' }])
    );
    const result = await stream.result();

    if (skipIfRateLimited(check, result)) return;

    const text = (result.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');

    check.soft(Boolean(text), '流里没有文本，模型没答');

    const usage = result.usage;
    // pi 把缺失的 usage 归一成 0；全 0 视为「网关没回传」→ SKIP（预期降级）
    const total = usage
      ? (usage.input || 0) + (usage.output || 0) + (usage.totalTokens || 0)
      : 0;

    if (!usage || total === 0) {
      check.skip('该网关不回传 usage（面板用量会显示为空，属预期降级）');

      return;
    }

    check.hard(
      Number.isFinite(usage.input) && Number.isFinite(usage.output),
      `usage 字段不是数字: ${JSON.stringify(usage)}`
    );
    console.log(`        usage: in=${usage.input} out=${usage.output}`);
  },
};