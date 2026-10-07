/**
 * 装配层：配置写盘 → 解密读回（原 live-assembly [0]）。
 *
 * 不需要模型，是最便宜的一条 —— 放在清单最前当冒烟。
 */
export default {
  id: 'assembly/config',
  title: '装配层：配置写盘 → 解密读回',
  layer: 'assembly',
  async run({ config, configDoc, setupAssembly, check }) {
    const a = await setupAssembly({ doc: configDoc, tabs: [], pageText: '' });

    if (!a.saved.ok) {
      check.hard(false, `配置写盘失败: ${(a.saved.errors || []).join()}`);

      return;
    }

    const back = await a.loadConfig(a.configIO);

    check.hard(
      back.apiKey === config.apiKey,
      '密钥读回不一致（密文写入 / 明文读回链路断了）'
    );
    check.hard(
      back.baseUrl === config.baseUrl,
      `baseUrl 读回不一致: ${back.baseUrl}`
    );
    check.hard(back.model === config.model, `model 读回不一致: ${back.model}`);
  },
};