/**
 * 在页面上高亮一批元素（「验证选择器」用）。
 *
 * 取自 handlerVerifySelector，抽出来是为了能在真实浏览器里单测。
 * 两个坑，都是实测踩出来的，改这里前先读：
 *
 * 1. scrollIntoView({ behavior: 'smooth' }) 是**异步**的 —— 调用返回时页面还在滚。
 *    旧实现只 sleep(200) 就取 getBoundingClientRect()，量到的是滚动途中的坐标；
 *    坐标塞进 position: fixed 的遮罩后，剩下的滚动会让高亮框整体偏离元素。
 *    滚动距离越长偏差越大：多选时 elements[0] 通常是页面最上方那个匹配元素，
 *    离当前视口最远，实测偏差 3314px；单选选的多是眼前那个元素，实测只差 141px，
 *    肉眼几乎看不出来 —— 这就是「单选基本都成功、多选不相符」的由来。
 *    所以必须等滚动真正停下（waitScrollEnd）再画，不能用固定 sleep 猜。
 *
 * 2. 视口坐标只在取的那一瞬间有效。遮罩要挂 1.7s，这期间页面若再滚动
 *    （平滑滚动的尾巴、懒加载撑高页面、用户手滑），框会飘离元素，
 *    于是监听 scroll/resize 重算。传 capture: true 是为了连**内层滚动容器**
 *    的滚动也能收到（那种滚动 window 上根本没有 scroll 事件）。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SCROLL_SETTLE_MS = 150;
const SCROLL_SETTLE_TIMEOUT = 2000;

/**
 * 等到「连续 SCROLL_SETTLE_MS 内没有任何滚动事件」为止。
 * 用滚动事件判定而不是比对 window.scrollY：后者对内层滚动容器完全失效。
 * 兜底 SCROLL_SETTLE_TIMEOUT，避免页面有持续滚动动画时永远等下去。
 */
export function waitScrollEnd(
  target = document,
  timeout = SCROLL_SETTLE_TIMEOUT
) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let idleTimer = null;
    let hardTimer = null;
    let isDone = false;

    const finish = () => {
      if (isDone) return;
      isDone = true;

      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      controller.abort();

      resolve();
    };

    target.addEventListener(
      'scroll',
      () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, SCROLL_SETTLE_MS);
      },
      { capture: true, signal: controller.signal }
    );

    hardTimer = setTimeout(finish, timeout);

    // 先起一个静止窗口：一次滚动都没发生时也能按时返回
    idleTimer = setTimeout(finish, SCROLL_SETTLE_MS);
  });
}

export default async function highlightElements(elements, options = {}) {
  const { duration = 1700, scrollToFirst = true, root = document } = options;

  const items = Array.from(elements).filter(Boolean);
  if (items.length === 0) return;

  if (scrollToFirst) {
    // 监听器必须先挂上再触发滚动，否则会漏掉最早的那几帧
    const scrollSettled = waitScrollEnd(root);

    items[0].scrollIntoView({
      block: 'center',
      inline: 'center',
      behavior: 'smooth',
    });

    await scrollSettled;
  }

  const overlay = document.createElement('div');
  overlay.style =
    'height: 100%; width: 100%; top: 0; left: 0; background-color: rgb(0 0 0 / 0.3); pointer-events: none; position: fixed; z-index: 99999';

  const svgEl = document.createElementNS(SVG_NS, 'svg');
  svgEl.style =
    'height: 100%; width: 100%; top: 0; left: 0; pointer-events: none; position: relative;';

  overlay.appendChild(svgEl);

  const rectEls = items.map(() => {
    const rectEl = document.createElementNS(SVG_NS, 'rect');

    rectEl.setAttribute('stroke', '#2563EB');
    rectEl.setAttribute('stroke-width', '2');
    rectEl.setAttribute('fill', 'rgba(37, 99, 235, 0.4)');

    svgEl.appendChild(rectEl);

    return rectEl;
  });

  const controller = new AbortController();

  // 高亮框画的是视口坐标，遮罩是 fixed —— 页面一动就得重画，否则框会飘离元素
  const updateRects = () => {
    items.forEach((element, index) => {
      const { left, top, width, height } = element.getBoundingClientRect();

      rectEls[index].setAttribute('x', left);
      rectEls[index].setAttribute('y', top);
      rectEls[index].setAttribute('width', width);
      rectEls[index].setAttribute('height', height);
    });
  };

  updateRects();

  root.body.appendChild(overlay);

  root.addEventListener('scroll', updateRects, {
    capture: true,
    signal: controller.signal,
  });
  root.defaultView.addEventListener('resize', updateRects, {
    signal: controller.signal,
  });

  await new Promise((resolve) => {
    setTimeout(resolve, duration);
  });

  controller.abort();
  overlay.remove();
}
