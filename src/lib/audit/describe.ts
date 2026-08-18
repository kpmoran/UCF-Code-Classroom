/**
 * Human descriptions for audit log entries.
 *
 * The log is only useful if an instructor can read it months later without
 * knowing the schema, so each action gets a sentence rather than a raw key. Pure,
 * so the wording is testable.
 */

export type AuditDetail = Record<string, unknown> | null

function str(detail: AuditDetail, key: string): string | null {
  const value = detail?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(detail: AuditDetail, key: string): number | null {
  const value = detail?.[key]
  return typeof value === 'number' ? value : null
}

const REPO_ACTION_TEXT: Record<string, string> = {
  KEEP: 'repositories kept',
  ARCHIVE: 'repositories archived',
  DELETE: 'repositories deleted',
}

/** One-line description of what happened. */
export function describeAuditAction(action: string, detail: AuditDetail): string {
  switch (action) {
    case 'classroom.create':
      return `Created the classroom, backed by ${str(detail, 'org') ?? 'a GitHub organization'}`
    case 'classroom.update':
      return 'Changed classroom settings'
    case 'classroom.archive':
      return 'Archived the classroom'
    case 'classroom.unarchive':
      return 'Restored the classroom'
    case 'classroom.invite_link.regenerate':
      return 'Generated a new invite link, revoking the previous one'

    case 'roster.import': {
      const added = num(detail, 'added') ?? 0
      const updated = num(detail, 'updated') ?? 0
      const removed = num(detail, 'removed') ?? 0
      const skipped = num(detail, 'removalsSkipped') ?? 0
      const parts = [`${added} added`, `${updated} updated`, `${removed} removed`]
      if (skipped > 0) parts.push(`${skipped} absent from the file but kept`)
      return `Imported a Canvas roster: ${parts.join(', ')}`
    }
    case 'roster.claim':
      return `Linked their GitHub account to ${str(detail, 'displayName') ?? 'a roster entry'}`
    case 'roster.unlink':
      return `Unlinked the GitHub account from ${str(detail, 'displayName') ?? 'a roster entry'}`
    case 'roster.remove':
      return `Removed ${str(detail, 'displayName') ?? 'a student'} from the roster`
    case 'roster.restore':
      return `Restored ${str(detail, 'displayName') ?? 'a student'} to the roster`

    case 'assignment.create':
      return `Created the assignment “${str(detail, 'title') ?? 'untitled'}” from ${
        str(detail, 'template') ?? 'a template'
      }`
    case 'assignment.publish':
      return `Published “${str(detail, 'title') ?? 'an assignment'}”`
    case 'assignment.unpublish':
      return `Unpublished “${str(detail, 'title') ?? 'an assignment'}”`
    case 'assignment.bulk_provision':
      return `Queued ${num(detail, 'queued') ?? 0} repositories for creation`
    case 'assignment.retry_failed':
      return `Re-queued ${num(detail, 'retried') ?? 0} failed repositories`
    case 'assignment.remove_student': {
      const repo = str(detail, 'repo')
      const what = REPO_ACTION_TEXT[str(detail, 'repoAction') ?? ''] ?? 'access revoked'
      return `Removed a student from an assignment (${what})${repo ? ` — ${repo}` : ''}`
    }

    case 'team.create':
      return `Created team “${str(detail, 'name') ?? 'unnamed'}”`
    case 'team.join':
      return `Joined team “${str(detail, 'teamName') ?? 'unnamed'}”`
    case 'team.leave':
      return `Left team “${str(detail, 'teamName') ?? 'unnamed'}”${
        detail?.teamDeleted === true ? ' (the empty team was removed)' : ''
      }`
    case 'team.provision':
      return `Queued repository creation for team “${str(detail, 'teamName') ?? 'unnamed'}”`
    case 'team.move_member': {
      const from = str(detail, 'from')
      const to = str(detail, 'to')
      return from
        ? `Moved a student from team “${from}” to “${to ?? 'another team'}”`
        : `Added a student to team “${to ?? 'a team'}”`
    }
    case 'team.remove_member':
      return `Removed a student from team “${str(detail, 'teamName') ?? 'unnamed'}”`

    case 'member.role_change': {
      const from = str(detail, 'from')
      const to = str(detail, 'to')
      const who = str(detail, 'who')
      return `Changed ${who ?? 'a member'}’s role from ${from ?? '?'} to ${to ?? '?'}`
    }
    case 'member.remove': {
      const who = str(detail, 'who')
      const what = REPO_ACTION_TEXT[str(detail, 'repoAction') ?? ''] ?? 'access revoked'
      return `Removed ${who ?? 'a member'} from the classroom (${what})`
    }

    case 'github.access_revoked': {
      const login = str(detail, 'githubLogin')
      const failures = Array.isArray(detail?.failures) ? detail.failures.length : 0
      const base = `Revoked GitHub access for ${login ? `@${login}` : 'a student'}`
      return failures > 0 ? `${base} — ${failures} problem(s), see details` : base
    }

    default:
      // Unknown actions still render readably rather than as a blank row.
      return action
  }
}

/** Whether an entry represents something destructive, for visual emphasis. */
export function isDestructiveAction(action: string, detail: AuditDetail): boolean {
  if (str(detail, 'repoAction') === 'DELETE') return true

  return [
    'classroom.archive',
    'roster.remove',
    'roster.unlink',
    'member.remove',
    'assignment.remove_student',
    'team.remove_member',
    'github.access_revoked',
  ].includes(action)
}
