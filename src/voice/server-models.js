// Voice models on Holding Local (the computer). Same idea as models.js, but the
// files live in ~/.holding-local/models and the server downloads and deletes them.
//
// GET    /v1/voice-models                 -> { models: [...], selected, disk: { free_bytes } }
// POST   /v1/voice-models/{id}/download   -> starts (or resumes) a download in the background
// DELETE /v1/voice-models/{id}            -> removes the files, frees the space
// POST   /v1/voice-models/select {id}     -> the voice the server uses when a request names none

function api(cfg = {}) {
  const base = String(cfg.baseUrl || 'http://127.0.0.1:8787/v1').replace(/\/$/, '');
  const headers = cfg.token ? { Authorization: `Bearer ${cfg.token}`, 'X-Pair-Token': cfg.token } : {};
  return async (path, init = {}) => {
    const r = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) }, signal: init.signal || AbortSignal.timeout(8000) });
    let body = null; try { body = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw new Error(body?.detail || body?.error?.message || (r.status === 404 ? 'This Holding Local is too old to manage voices. Update it and try again.' : `Holding Local answered ${r.status}`));
    return body;
  };
}

export const listServerModels = (cfg) => api(cfg)('/voice-models');
export const downloadServerModel = (cfg, id) => api(cfg)(`/voice-models/${encodeURIComponent(id)}/download`, { method: 'POST' });
export const deleteServerModel = (cfg, id) => api(cfg)(`/voice-models/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const selectServerModel = (cfg, id) => api(cfg)('/voice-models/select', { method: 'POST', body: JSON.stringify({ id }) });

// Pre-recording a parent's scripted lines with Chatterbox on the computer.
export const startPrerender = (cfg, body) => api(cfg)('/voice-prerender', { method: 'POST', body: JSON.stringify(body) });
export const prerenderStatus = (cfg) => api(cfg)('/voice-prerender');
export const stopPrerender = (cfg) => api(cfg)('/voice-prerender', { method: 'DELETE' });
