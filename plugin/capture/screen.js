const patterns = [
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/i,
  /\b(?:authorization\s*:\s*)?bearer\s+\S+/i,
  /\b(?:password|passwd|pwd|secret|token|(?:access|refresh|auth)[_ -]?token|api[_ -]?key|access[_ -]?key|client[_ -]?secret)\b["']?\s*(?:[:=]|\bis\b)\s*\S+/i,
  /\b(?:store|save|remember)\s+(?:the\s+)?(?:password|secret|credentials?)\b/i,
  /\bcredentials?\b\s*(?:[:=]|[<"'])\s*\S+/i,
  /(?:密码|密钥|令牌|凭据)\s*[:：=]\s*\S+/u,
  /[a-z][a-z\d+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
];

export function clean(value) {
  const strings = [JSON.stringify(value)];
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') strings.push(current);
    else if (current && typeof current === 'object') pending.push(...Object.keys(current), ...Object.values(current));
  }
  const text = strings.join('\n');
  return text.isWellFormed() && !patterns.some((pattern) => pattern.test(text));
}
