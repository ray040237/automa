/**
 * T-227 测试桩：见 vue-shell-vue-i18n.js 头注。
 */
export function useRouter() {
  throw new Error(
    'useRouter 只能在组件 setup 里调（薄壳层），node --test 不覆盖'
  );
}
