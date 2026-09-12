/**
 * Adopting a repository that already exists.
 *
 * Pure, and shared by both assignment types: a group assignment links one
 * repository per team, an individual one links a repository per student, and the
 * refusals are the same in both directions. Kept out of the actions so each reason
 * an instructor can hit is testable without a database or a GitHub token.
 */

export type AdoptResult = { allowed: true } | { allowed: false; reason: string }

const ALLOWED = { allowed: true } as const

export type AdoptInput = {
  repoSource: 'CREATE' | 'EXISTING'
  /** The classroom's GitHub organization. */
  orgLogin: string
  /** Parsed reference, or null when the input could not be read as a repository. */
  ref: { owner: string; repo: string } | null
  /**
   * Who already holds this repository on the same assignment, when holding it twice
   * is not allowed — the name is used in the refusal.
   *
   * Teams pass the other team's name: two teams sharing one repository is a paste
   * into the wrong row. Individual assignments pass null, because assigning several
   * students to one repository is a thing an instructor may genuinely want.
   */
  conflictsWith: string | null
}

export function canAdoptRepo(input: AdoptInput): AdoptResult {
  if (input.repoSource !== 'EXISTING') {
    return {
      allowed: false,
      reason:
        'This assignment creates its own repositories. Linking one that already exists is only ' +
        'available on an assignment set up for it.',
    }
  }

  if (!input.ref) {
    return {
      allowed: false,
      reason: 'Could not read that as a repository. Use owner/name or a GitHub URL.',
    }
  }

  /*
   * Same organization only.
   *
   * Not a policy choice so much as the limit of what this app can do: access is
   * granted through the classroom's installation, and the autograding workflow, the
   * feedback branch and the deadline lock are all written with its token. A
   * repository in someone's personal account would link fine and then fail every one
   * of those, so it is refused up front with the reason.
   */
  if (input.ref.owner.toLowerCase() !== input.orgLogin.toLowerCase()) {
    return {
      allowed: false,
      reason:
        `${input.ref.owner}/${input.ref.repo} is outside ${input.orgLogin}. Repositories must ` +
        'be in the classroom organization, because access and autograding are granted there.',
    }
  }

  if (input.conflictsWith) {
    return {
      allowed: false,
      reason: `${input.ref.owner}/${input.ref.repo} is already linked to ${input.conflictsWith}.`,
    }
  }

  return ALLOWED
}
