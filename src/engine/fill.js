// Token filling shared by the engine and build scripts (keep deterministic: prerecorded audio matches on text).
export function fill(t, ctx = {}) {
  const e = ctx.endearment || '';
  let s = t;
  if (!e) s = s.replace(/,\s*\{endearment\}/g, '').replace(/\{endearment\},\s*/g, '').replace(/\{endearment\}/g, '');
  else s = s.replace(/\{endearment\}/g, e);
  if (!ctx.userName) s = s.replace(/,\s*\{name\}/g, '').replace(/\{name\},\s*/g, '').replace(/\{name\}/g, '');
  else s = s.replace(/\{name\}/g, ctx.userName);
  s = s.replace(/\{miss\}/g, ctx.miss || 'moved too fast');
  s = s.replace(/\s+([,.!?])/g, '$1').replace(/^\s*([a-z])/, (m, c) => c.toUpperCase()).trim();
  return s;
}

