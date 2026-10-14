import './message-listener';

import BrowserAPIService from '@/service/browser-api/BrowserAPIService';
import { loadLocaleMessages, setI18nLanguage } from '@/lib/vueI18n';

/**
 * 引擎侧也要加载语言包（T-262）。
 *
 * `log-data` 块（handlerLogData.js）在 **offscreen** 里跑 `getTranslateLog`，
 * 而语言包此前只在 newtab / params / popup / sidepanel 四个宿主加载
 * （见 `loadLocaleMessages` 的调用点）。于是 `te()` 恒为 false、`t()` 回落成 key
 * —— 块拿到的就是 `variable-not-found` 这类 slug 而不是译文。这既影响 T-262
 * 新增的 slug，也影响那之前就存在的 27 条。
 *
 * **两个动作缺一不可**（实测踩过）：只调 `loadLocaleMessages` 不够 —— 它只把词条
 * 塞进实例，**不切换** `i18n.global.locale`，而 `createI18n` 没给 `locale` 时
 * 默认是 **`en-US`**（既不是 `en` 也不是 `zh`），所以 `te()` 照样 false、
 * 表现为「词条明明能 t() 出来，日志里却仍是 slug」。必须再 `setI18nLanguage`
 * 把 locale 拨到 `en`/`zh` 等已加载的那一个上。
 *
 * 只加载 `newtab.json`：引擎侧用到的只有 `log.messages`（日志消息）与
 * `workflow.blocks.*`（日志里的块名），其余语言包在 offscreen 无用。
 *
 * 顺序上放在 `./message-listener` 之后：监听器必须先挂好，词条晚一点到位
 * 只是让最早的几条日志回落到 slug，不会漏掉消息。
 */
async function loadLocale(locale) {
  try {
    await loadLocaleMessages(locale, 'newtab');
    await setI18nLanguage(locale);
  } catch (error) {
    console.error('[offscreen] 加载语言包失败：', error);
  }
}

(async () => {
  const { settings } = await BrowserAPIService.storage.local.get('settings');

  await loadLocale(settings?.locale || 'en');

  // 用户在设置里切换语言时同步 —— offscreen 文档不像 newtab 那样会随页面
  // 重新加载，不监听的话改了语言要等 offscreen 重建才生效。
  BrowserAPIService.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.settings) return;

    const locale = changes.settings.newValue?.locale;
    if (locale) loadLocale(locale);
  });
})();
