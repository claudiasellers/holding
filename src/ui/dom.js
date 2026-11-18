export function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') n.innerHTML = v;
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
export function toast(msg, ms = 2600) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, ms);
}
export function slider(label, value, onInput, { min = 0, max = 1, step = .01, hint } = {}) {
  const id = 's' + Math.random().toString(36).slice(2, 7);
  const out = h('output', { for: id }, '');
  const inp = h('input', { type: 'range', id, min, max, step, value });
  const fmt = (v) => (max <= 1 ? Math.round(v * 100) + '%' : v);
  out.textContent = fmt(+value);
  inp.addEventListener('input', () => { out.textContent = fmt(+inp.value); onInput(+inp.value); });
  return h('label', { class: 'field slider', for: id }, h('span', { class: 'lbl' }, label, hint ? h('small', {}, hint) : null), h('div', { class: 'row' }, inp, out));
}
export function select(label, value, options, onChange) {
  const sel = h('select', { onchange: (e) => onChange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), sel);
}
export function toggle(label, value, onChange, hint) {
  const inp = h('input', { type: 'checkbox', role: 'switch', checked: !!value, onchange: (e) => onChange(e.target.checked) });
  return h('label', { class: 'field toggle' }, h('span', { class: 'lbl' }, label, hint ? h('small', {}, hint) : null), inp);
}
export function swatches(label, value, colors, onPick) {
  const wrap = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': label });
  for (const c of colors) {
    const b = h('button', { class: 'sw' + (c === value ? ' on' : ''), style: { background: c }, 'aria-label': c, role: 'radio', 'aria-checked': c === value ? 'true' : 'false', onclick: () => { wrap.querySelectorAll('.sw').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); }); b.classList.add('on'); b.setAttribute('aria-checked', 'true'); onPick(c); } });
    wrap.append(b);
  }
  return h('div', { class: 'field' }, h('span', { class: 'lbl' }, label), wrap);
}
export function chips(label, value, options, onPick) {
  const wrap = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': label });
  for (const [v, l] of options) {
    const b = h('button', { class: 'chip' + (v === value ? ' on' : ''), role: 'radio', 'aria-checked': v === value ? 'true' : 'false', onclick: () => { wrap.querySelectorAll('.chip').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); }); b.classList.add('on'); b.setAttribute('aria-checked', 'true'); onPick(v); } }, l);
    wrap.append(b);
  }
  return h('div', { class: 'field' }, label ? h('span', { class: 'lbl' }, label) : null, wrap);
}
