/**
 * `secrets` 的测试桩 —— webpack externals，Node 里解析不到。
 *
 * 形状取自 `secrets.blank.js`（真实构建用的空壳）。测试只关心 offline 分支，
 * 那里的 `fetchApi` 在读到 `secrets.baseApiUrl` 之前就抛了；给出同形值即可。
 */
export default {
  baseApiUrl: '',
};
