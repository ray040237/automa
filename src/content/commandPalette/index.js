import browser from 'webextension-polyfill';
import { appendToDocument } from '@/utils/domMount';
import initApp from './main';
import injectAppStyles from '../injectAppStyles';

function pageLoaded() {
  return new Promise((resolve) => {
    const checkDocState = () => {
      if (document.readyState === 'loading') {
        setTimeout(checkDocState, 1000);
        return;
      }

      resolve();
    };

    checkDocState();
  });
}

export default async function () {
  try {
    const isMainFrame = window.self === window.top;
    if (!isMainFrame) return;

    // 非 HTML 文档排除：json / xml 早就在名单里，svg 是 T-251 补的 ——
    // SVG 文档没有 document.body，命令面板这种 HTML 容器挂上去也没意义。
    const isInvalidURL = /\.(json|xml|svg)$/.test(window.location.pathname);
    if (isInvalidURL) return;

    const { automaShortcut } = await browser.storage.local.get(
      'automaShortcut'
    );
    if (Array.isArray(automaShortcut) && automaShortcut.length === 0) return;

    await pageLoaded();

    const instanceExist = document.querySelector('automa-palette');
    if (instanceExist) return;

    const element = document.createElement('div');
    element.attachShadow({ mode: 'open' });
    element.id = 'automa-palette';

    await injectAppStyles(element.shadowRoot);
    await initApp(element);

    appendToDocument(element);
  } catch (error) {
    console.error(error);
  }
}
