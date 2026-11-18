// When to show the "Keep a line that helped?" sheet after a conversation ends.
// Asking every time turns a soft offer into a chore, so by default it is rare:
// the first time (so people learn keepsakes exist), then at most once a week,
// and only after a conversation long enough to have something worth keeping.
// The "Save lines" button in the session is always there for everything else.

export const END_PROMPT_GAP_DAYS = 7;
export const END_PROMPT_MIN_MINUTES = 3;

/**
 * @param {{ pref?: 'sometimes'|'always'|'never', lastShown?: number|null, now?: number,
 *           minutes?: number, saidCount?: number, mode?: string }} o
 */
export function shouldAskOnEnd({ pref = 'sometimes', lastShown = null, now = Date.now(), minutes = 0, saidCount = 0, mode = 'hold' } = {}) {
  if (pref === 'never') return false;
  const somethingToKeep = saidCount > 0 || mode === 'makesense';
  if (!somethingToKeep) return false;
  if (pref === 'always') return true;
  if (!lastShown) return true;
  if (minutes < END_PROMPT_MIN_MINUTES) return false;
  return now - lastShown >= END_PROMPT_GAP_DAYS * 864e5;
}
