/** 探针（三）：工具返回 {status,payload} 对象时，观察值到底长什么样。node --import ./utils/test-loader.mjs .agent-test/observation-shape-probe.mjs */
import { wrapObservation } from '../src/agent/events.js';

// 1) 页面工具今天返回字符串（read_page）
const asText = wrapObservation({
  status: 'ok',
  payload: '命中 3 个：.card',
  wrap: 'untrusted_page_content',
});

// 2) query_elements / test_js / highlight / tabs / canvas 返回 {status,payload}
const asObject = wrapObservation({
  status: 'ok',
  payload: { status: 'ok', payload: '命中 3 个：.card' },
  wrap: 'untrusted_page_content',
});

// 3) 工具内部返回 {status:'error'} —— loop 那侧 status 是 OK，走不到错误分支
const asInnerError = wrapObservation({
  status: 'ok',
  payload: { status: 'error', payload: '选择器不合法：bad [' },
  wrap: 'untrusted_page_content',
});

console.log('--- 字符串返回 ---');
console.log(asText);
console.log('\n--- 对象返回（现状）---');
console.log(asObject);
console.log('\n--- 内层 error 返回（现状）---');
console.log(asInnerError);
console.log('\n字符数对比: 字符串', asText.length, ' vs 对象', asObject.length);
