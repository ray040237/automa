/**
 * T-227 测试桩：见 vue-shell-vue-i18n.js 头注。
 * 这个包是 CJS 互操作，node ESM 下连具名导出都解不出 —— 必须发桩才能让
 * agentHost.js（薄壳）整体可 import，工厂测试才跑得起来。
 */
export function useToast() {
  throw new Error(
    'useToast 只能在组件 setup 里调（薄壳层），node --test 不覆盖'
  );
}
