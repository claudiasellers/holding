import { PRESETS } from './data/archetypes.js';
import { createFace, createLight } from './face/render.js';
import { markedForm } from './face/mirror.js';
import { OWN } from './face/expressions.js';

const COLS = [['holding', 'Own (holding)'], ['sad', 'sad'], ['scared', 'scared'], ['angry', 'angry'], ['ashamed', 'ashamed'], ['lonely', 'lonely'], ['overwhelmed', 'overwhelmed'], ['numb', 'numb'], ['glad', 'glad']];
const t = document.getElementById('t');
const head = t.insertRow(); head.append(Object.assign(document.createElement('th'), { textContent: '' }));
for (const [, l] of COLS) head.append(Object.assign(document.createElement('th'), { textContent: l }));
for (const a of PRESETS) {
  const r = t.insertRow();
  const th = document.createElement('th'); th.className = 'rowh'; th.innerHTML = `${a.name}<br><small>${a.title}</small>`; r.append(th);
  for (const [k] of COLS) {
    const td = r.insertCell(); const box = document.createElement('div'); box.className = 'cell'; td.append(box);
    const f = a.abstract ? createLight(box, a) : createFace(box, a);
    const e = k === 'holding' ? OWN.holding : markedForm(k, 1, a.mirror.markedness, a.stance.warmth);
    f.frame(e, { blink: 0, mouth: 0, breath: 0 });
  }
}
