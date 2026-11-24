function isBalanced(s) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const openers = new Set(['(', '[', '{']);
  const stack = [];
  for (const ch of s) {
    if (openers.has(ch)) {
      stack.push(ch);
    } else if (ch in pairs) {
      if (stack.length === 0 || stack.pop() !== pairs[ch]) {
        return false;
      }
    }
    // 括弧以外の文字は無視
  }
  return stack.length === 0;
}

module.exports = { isBalanced };
