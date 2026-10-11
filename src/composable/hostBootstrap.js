/**
 * 独立 HTML 宿主入口的启动链（T-227）。
 *
 * 侧栏这类不吃 newtab 启动链的入口，原先要自己背四步咒语（newtab/App.vue:356-364
 * 的顺序照抄）：先 loadSettings() 拿用户选的 locale → loadLocaleMessages 注入
 * 词条 → setI18nLanguage 生效 → theme.init() 把 <html> 的 dark 类挂上。
 * 漏任何一步的故障各不相同：键名直显 / 主题恒亮。现在顺序知识只在这里说一次，
 * 宿主调一行拿回 { localeLoaded }（面板等它就绪再挂，防 t() 抢跑）。
 *
 * **<ui-dialog> 不在这层**：挂载对话框接收器是模板关注点，各宿主在自己的
 * template 里放 `<ui-dialog />`（漏挂的表现是「点删除，事件发进虚空」，
 * 见 sidepanel/App.vue 的注释与守卫）。
 *
 * @param {Object} [opts]
 * @param {string} [opts.localeLocation] 语言包位置；面板文案在 newtab.json，
 *   恒为 'newtab' —— 不存在 'sidepanel' 语言包文件，别想当然改这个值。
 * @returns {{localeLoaded: import('vue').Ref<boolean>}}
 */

import { ref } from 'vue';
import { useTheme } from '@/composable/theme';
import { loadLocaleMessages, setI18nLanguage } from '@/lib/vueI18n';
import { useStore } from '@/stores/main';

export function useHostBootstrap({ localeLocation = 'newtab' } = {}) {
  const localeLoaded = ref(false);

  // 主题不依赖 locale，同步先行（与原侧栏写法同序：theme.init() 在前）
  useTheme().init();

  (async () => {
    try {
      const store = useStore();
      await store.loadSettings();

      const { locale } = store.settings;
      await loadLocaleMessages(locale, localeLocation);
      await setI18nLanguage(locale);
    } catch (err) {
      console.error('[host] bootstrap failed:', err);
    } finally {
      // 读不到 locale 也要放行面板：宁可显示英文兜底，不要整块空白
      localeLoaded.value = true;
    }
  })();

  return { localeLoaded };
}
