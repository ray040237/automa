/**
 * T-227 测试桩：agentHost 薄壳的 useI18n 在 node --test 下不可用
 * （Vue 上下文只在组件 setup 里存在）。工厂测试只 import 模块、不调它。
 */
export function useI18n() {
  throw new Error(
    'useI18n 只能在组件 setup 里调（薄壳层），node --test 不覆盖'
  );
}
