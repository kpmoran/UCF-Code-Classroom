/**
 * Formatting deadlines for form inputs.
 *
 * Extracted and tested because the obvious implementation is wrong in a way that
 * is easy to ship: `toISOString().slice(0, 16)` converts to UTC, so an instructor
 * east or west of Greenwich would be shown a different time than the one they set,
 * and saving the form would silently move the deadline.
 */

/**
 * Format a Date for a `datetime-local` input, which expects local wall-clock time
 * with no zone designator and no seconds.
 */
export function toDateTimeLocal(date: Date | null | undefined): string {
  if (!date) return ''
  if (Number.isNaN(date.getTime())) return ''

  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}
