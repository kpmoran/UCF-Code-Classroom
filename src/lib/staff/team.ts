import 'server-only'

import { db } from '@/lib/db'
import {
  addTeamMembership,
  addTeamRepoAccess,
  createTeam,
  removeTeamMembership,
  removeTeamRepoAccess,
} from '@/lib/github/operations/teams'

/**
 * The GitHub team that gives a classroom's staff access to student repositories.
 *
 * This closes a gap that was invisible from inside the app: `ClassroomRole.TA`
 * only ever governed what someone could see in *this* application. Nothing granted
 * access to the repositories themselves — provisioning adds exactly one
 * collaborator, the student — so an instructor could read student work only by
 * being an organization owner, and a TA who was a plain org member could read
 * nothing at all.
 *
 * A team rather than direct collaborators, for two reasons that both get worse as
 * a class grows:
 *
 *   - **Cost.** Granting a team access is one write per repository no matter how
 *     many staff there are. Adding each person individually is staff × repos, all
 *     of it against the same content-creation budget as provisioning.
 *   - **Churn.** A TA who joins in week six is added to the team once. As
 *     collaborators they would have to be added to every repository that already
 *     exists, and remembered for every one created afterwards.
 *
 * Revoking is the same argument in reverse: one team removal, not forty.
 */

/** Enough access to read, clone, comment and push feedback — and nothing more. */
export const STAFF_PERMISSION = 'push' as const

/**
 * The team's name on GitHub.
 *
 * Named for the course rather than the classroom id, because an organization
 * hosting several courses ends up with several of these and somebody has to tell
 * them apart in GitHub's own UI. Falls back to the classroom name when the course
 * code and term are both unset, which they are allowed to be — an empty label would
 * produce a team called "-staff" shared by every such classroom in the org, which is
 * worse than a long name.
 */
export function staffTeamName(classroom: {
  name: string
  courseCode: string | null
  term: string | null
}): string {
  const label = [classroom.courseCode, classroom.term].filter(Boolean).join('-')
  return `${label || classroom.name}-staff`
}

export type StaffSyncResult = {
  teamSlug: string
  /** Staff whose membership is now active or pending. */
  synced: string[]
  /** Staff with no linked GitHub account, who cannot be added to anything. */
  unlinked: string[]
  /** Members removed because they are no longer staff in this classroom. */
  removed: string[]
}

/**
 * Make the staff team exist and hold exactly this classroom's instructors and TAs.
 *
 * Idempotent: `createTeam` returns an existing team rather than failing, and
 * membership writes are upserts. Safe to run whenever staff change, which is the
 * only time it needs to run at all.
 */
export async function syncStaffTeam(classroomId: string): Promise<StaffSyncResult> {
  const classroom = await db.classroom.findUniqueOrThrow({
    where: { id: classroomId },
    select: {
      name: true,
      courseCode: true,
      term: true,
      githubOrgLogin: true,
      installationId: true,
      staffTeamSlug: true,
      members: {
        where: { role: { in: ['INSTRUCTOR', 'TA'] } },
        select: { user: { select: { name: true, githubLogin: true } } },
      },
    },
  })

  const org = classroom.githubOrgLogin
  const installationId = classroom.installationId

  const { team } = await createTeam(
    classroomId,
    installationId,
    org,
    staffTeamName(classroom),
    `Instructors and TAs for ${classroom.name}`,
  )

  if (classroom.staffTeamSlug !== team.slug) {
    await db.classroom.update({ where: { id: classroomId }, data: { staffTeamSlug: team.slug } })
  }

  const synced: string[] = []
  const unlinked: string[] = []
  for (const member of classroom.members) {
    const login = member.user.githubLogin
    if (!login) {
      // Reported rather than skipped silently. "My TA still cannot see anything" is
      // most often this: they have an account in the app and never linked GitHub.
      unlinked.push(member.user.name ?? 'unnamed member')
      continue
    }
    await addTeamMembership(classroomId, installationId, org, team.slug, login)
    synced.push(login)
  }

  return { teamSlug: team.slug, synced, unlinked, removed: [] }
}

/**
 * Remove someone from the staff team.
 *
 * Separate from `syncStaffTeam` because that function only knows who *is* staff.
 * Working out who used to be would mean listing the team and diffing it on every
 * sync, and the caller removing a member already knows exactly who to remove.
 */
export async function removeFromStaffTeam(
  classroomId: string,
  githubLogin: string,
): Promise<boolean> {
  const classroom = await db.classroom.findUniqueOrThrow({
    where: { id: classroomId },
    select: { githubOrgLogin: true, installationId: true, staffTeamSlug: true },
  })
  if (!classroom.staffTeamSlug) return false

  await removeTeamMembership(
    classroomId,
    classroom.installationId,
    classroom.githubOrgLogin,
    classroom.staffTeamSlug,
    githubLogin,
  )
  return true
}

/**
 * Whether the staff team must be kept *off* a repository.
 *
 * True when someone who is staff in this classroom is also a participant in the
 * repository — a TA who accepted the assignment as a student, or a student later
 * promoted to TA. Accepting only needs a claimed roster entry and any classroom
 * role, so this is reachable without anyone doing something odd.
 *
 * The reason is the deadline lock. Locking works by lowering that person's *direct
 * collaborator* permission to `pull`, and GitHub resolves access to the highest
 * level across every source of grant — repository, team, organization. A team grant
 * of `push` therefore overrides the lock, and the app would report a repository as
 * locked while its owner could still push to it. Nothing in the row would look
 * wrong.
 *
 * The cost is that other staff cannot reach that one repository through the team.
 * That is the better trade: an instructor is an organization owner and can read it
 * anyway, and a lock that silently does not hold is worse than a repository that
 * needs opening a different way.
 */
export function staffTeamMustAvoidRepo(input: {
  participantUserIds: readonly string[]
  staffUserIds: readonly string[]
}): boolean {
  const staff = new Set(input.staffUserIds)
  return input.participantUserIds.some((id) => staff.has(id))
}

/** Take the staff team off one repository, so a direct-permission lock can hold. */
export async function revokeStaffAccessFromRepo(input: {
  classroomId: string
  installationId: bigint
  org: string
  teamSlug: string
  repo: string
}): Promise<void> {
  const { classroomId, installationId, org, teamSlug, repo } = input
  await removeTeamRepoAccess(classroomId, installationId, org, teamSlug, org, repo)
}

/** Grant the staff team access to one repository. */
export async function grantStaffAccessToRepo(input: {
  classroomId: string
  installationId: bigint
  org: string
  teamSlug: string
  repo: string
}): Promise<void> {
  const { classroomId, installationId, org, teamSlug, repo } = input
  await addTeamRepoAccess(
    classroomId,
    installationId,
    org,
    teamSlug,
    org,
    repo,
    STAFF_PERMISSION,
  )
}
