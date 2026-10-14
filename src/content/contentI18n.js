import browser from 'webextension-polyfill';
import { createI18n } from 'vue-i18n/dist/vue-i18n.esm-bundler';
import { supportLocales } from '@/utils/shared';

/**
 * content script 一族的 i18n 挂件。
 *
 * 与 newtab / popup / params 这些整页入口的差别：
 *
 * 1. locale 来源是异步的 —— 面板挂载时（用户点击后才出现）读
 *    `browser.storage.local` 的 settings.locale，宿主函数因此是 async，
 *    挂载点推迟到 locale 就绪后，不会出现「先闪英文再切换」。
 *
 * 2. 不设置宿主页面的 <html lang> —— content script 里的 document 是
 *    用户正在浏览的页面，不能改它的属性。
 *
 * 3. **词条必须静态导入（构建期预编译）**，既不能走 webpack chunk，也不能
 *    运行时取原始 json。三条路各有一个死结，只有静态导入能同时绕开：
 *
 *    a) 动态 `import()`（webpack chunk）：`output.publicPath` 是 '/'，在用户
 *       页面里会解析到**网页源** → chunk 404；就算把 publicPath 改到扩展源，
 *       chunk 也是用 `<script>` 加载的，会在**页面主世界**执行，它的
 *       `(self.webpackChunkautoma||[]).push(...)` 注册进主世界的全局数组，
 *       而 content script 的运行时在**隔离世界**，永远收不到 → chunk 明明
 *       200 却报 ChunkLoadError。
 *
 *    b) fetch 原始 json + `setLocaleMessage`：消息是**纯字符串**，vue-i18n
 *       会在翻译时用 `new Function` 现场编译（见 vue-i18n 的
 *       `compileToFunction`），而 MV3 的扩展 CSP 禁 `unsafe-eval` → 抛
 *       `EvalError`。更隐蔽的是失败形态：错误发生在**渲染期**，被 Vue 的
 *       `renderComponentRoot` catch 掉、只渲染一个注释节点，整块 UI 空白，
 *       控制台除了 EvalError 没有任何「组件挂了」的提示。
 *
 *    c) 在隔离世界 eval / new Function 执行 chunk：同样撞 MV3 CSP。
 *
 *    静态导入则让 `@intlify/vue-i18n-loader` 在**构建期**把每条消息编译成
 *    函数（`interactWithPage: e => e.normalize(["Interact with page"])`），
 *    运行时只做调用、不编译、不 eval —— 与 newtab 一族走的是同一条路径，
 *    语义（插值 / 复数）完全一致。
 *
 *    代价是词条要打进 bundle。只导 content 面板真正用到的两个文件：
 *    `common.json`（面板复用了 common.execute 等键）+ `content.json`。
 *    `blocks.json`（39KB/语言）面板用不到，不导；`popup.json` / `newtab.json`
 *    同理。这与 T-260 之前 `elementSelector/vueI18n.js` 静态导入
 *    enCommon + enBlocks 的做法一脉相承，只是从「只有英文」扩到多语言。
 *
 * 4. `content.json` 目前只有 en / zh / zh-TW 三个语言版本，其余语言缺的键
 *    靠 `fallbackLocale: 'en'` 逐键回退（与 newtab 缺键时的行为一致）。
 *
 * 各 content 入口（elementSelector / commandPalette / recordWorkflow）各自
 * createI18n 实例，互不影响；存储读取失败或不支持的 locale 一律回退 'en'
 * （保持改动前的行为）。
 */
import enCommon from '@/locales/en/common.json';
import esCommon from '@/locales/es/common.json';
import frCommon from '@/locales/fr/common.json';
import itCommon from '@/locales/it/common.json';
import ptBRCommon from '@/locales/pt-BR/common.json';
import trCommon from '@/locales/tr/common.json';
import ukCommon from '@/locales/uk/common.json';
import viCommon from '@/locales/vi/common.json';
import zhCommon from '@/locales/zh/common.json';
import zhTWCommon from '@/locales/zh-TW/common.json';
import enContent from '@/locales/en/content.json';
import zhContent from '@/locales/zh/content.json';
import zhTWContent from '@/locales/zh-TW/content.json';

const commonMessages = {
  en: enCommon,
  es: esCommon,
  fr: frCommon,
  it: itCommon,
  'pt-BR': ptBRCommon,
  tr: trCommon,
  uk: ukCommon,
  vi: viCommon,
  zh: zhCommon,
  'zh-TW': zhTWCommon,
};

const contentMessages = {
  en: enContent,
  zh: zhContent,
  'zh-TW': zhTWContent,
};

function messagesFor(locale) {
  const messages = {};

  if (commonMessages[locale]) Object.assign(messages, commonMessages[locale]);
  if (contentMessages[locale]) Object.assign(messages, contentMessages[locale]);

  return messages;
}

export async function createContentI18n() {
  const i18n = createI18n({
    legacy: false,
    fallbackLocale: 'en',
  });

  let locale = 'en';
  try {
    const { settings } = await browser.storage.local.get('settings');
    if (settings?.locale) locale = settings.locale;
  } catch (error) {
    console.error(error);
  }

  const isLocaleSupported = supportLocales.some(({ id }) => id === locale);
  if (!isLocaleSupported) {
    console.error(`${locale} locale is not supported, fallback to "en"`);
    locale = 'en';
  }

  // en 必须先落地：非 en 语言缺的词条（例如还没有 content.json 的
  // es / fr / it / pt-BR / tr / uk / vi）靠 fallbackLocale 逐键回退到英文。
  i18n.global.setLocaleMessage('en', messagesFor('en'));
  if (locale !== 'en') {
    i18n.global.setLocaleMessage(locale, messagesFor(locale));
  }
  i18n.global.locale.value = locale;

  return i18n;
}
