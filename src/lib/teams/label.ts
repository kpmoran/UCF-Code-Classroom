/**
 * How a team is referred to where it stands beside students.
 *
 * "Knights" alone reads as a surname in a column of surnames, so the prefix
 * says what it is. A team an instructor already called "Team 3" needs no help,
 * and "Team Team 3" is what this used to produce for it.
 */
export function teamLabel(name: string): string {
  return /^team\b/i.test(name.trim()) ? name.trim() : `Team ${name}`
}
