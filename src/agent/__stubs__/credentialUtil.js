/**
 * credentialUtil 测试桩：可逆的假加密。
 *
 * 只要求「加解密能往返」，不碰真实密钥 —— 测试里不需要那个强度。
 *
 * 刻意保持**同步**：真实的 credentialUtil 就是同步的。
 * 桩成 async 会让 loadConfig 里漏掉的 await 在测试里"看起来是必要的"，
 * 那就等于在用错误的假设保护代码。
 */
function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

function unb64(s) {
  return Buffer.from(String(s), 'base64').toString('utf8');
}

export default {
  encrypt(value) {
    return `test:${b64(value)}`;
  },
  decrypt(value) {
    return String(value).startsWith('test:')
      ? unb64(String(value).slice(5))
      : '';
  },
};
