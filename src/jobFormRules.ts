/**
 * What the one-time execution form sends when it saves. The page loads the
 * compiled module, as it does naming.js, so these rules are tested here
 * rather than only in a browser.
 *
 * Nothing here imports anything, for the same reason.
 */

/**
 * The `scheduledAt` a save sends.
 *
 * The date field only shows minutes, while a job saved as soon as possible is
 * dated to the millisecond. Sending the field back would move that date a few
 * seconds, and the hub takes a moved date as a new one, re-arming a job that
 * has already run. So unless the field was changed from what it showed when
 * the form opened, the saved instant goes back exactly as it was.
 *
 * `typed` is the field's local "YYYY-MM-DDTHH:mm", read in this clock's zone.
 */
export function scheduledAtForSave(saved: string | null | undefined, shownAtOpen: string, typed: string): string {
  const value = typed.trim();
  if (saved && value === shownAtOpen.trim()) return saved;
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

