// One place that turns raw failures ("Failed to fetch", "answered 401") into words a
// person can act on. Technical detail stays in the console.
export function friendlyError(err, where = '') {
  const raw = String(err?.message || err || '');
  console.warn('[holding]', where, raw);
  const phone = /iPhone|iPad|Android/i.test(navigator.userAgent);
  if (/Failed to fetch|Load failed|NetworkError|ECONNREFUSED|Couldn't reach|timed? ?out|abort/i.test(raw)) {
    if (where === 'pair' || phone) return 'Your computer didn\'t answer. Is Holding Local open there, and is this phone on the same network?';
    if (where === 'connect') return 'Holding Local isn\'t answering. If you\'ve installed it, click the heart in your menu bar and choose Open Holding.';
    return 'Your computer didn\'t answer. Check that Holding Local is open, then try again.';
  }
  if (/\b(401|403)\b|pair|token/i.test(raw)) return 'That pairing code didn\'t match. Check the code your computer shows.';
  if (/too old/i.test(raw)) return raw;
  if (/ollama pull|not found|404/i.test(raw)) return 'The server is there, but it doesn\'t have that model yet.';
  if (where === 'voice') return 'That voice couldn\'t play just now. Try another, or try again in a moment.';
  return 'Something went wrong on your computer. Try again in a moment.';
}
