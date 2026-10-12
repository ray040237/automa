import { sleep } from '@/utils/helper';
import handleSelector from '../handleSelector';
import highlightElements from '../highlightElements';

const SLEEP_TIME = 1700;

async function verifySelector(block) {
  let elements = await handleSelector(block);
  if (!elements) {
    await sleep(SLEEP_TIME);
    return { notFound: true };
  }

  if (!block.data.multiple) elements = [elements];

  // 高亮逻辑（含「等平滑滚动结束再取坐标」）在 highlightElements 里，见其头注释
  await highlightElements(elements, { duration: SLEEP_TIME });

  return { notFound: false };
}

export default verifySelector;
