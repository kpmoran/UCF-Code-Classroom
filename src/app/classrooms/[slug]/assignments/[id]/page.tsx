import Link from 'next/link'
import { forbidden, notFound } from 'next/navigation'

import { AssignmentStaffPanel } from '@/components/assignment-staff-panel'
import { AssignmentStudentPanel } from '@/components/assignment-student-panel'
import { AutogradingPanel } from '@/components/autograding-panel'
import { DeadlinePanel } from '@/components/deadline-panel'
import { FeedbackPrPanel } from '@/components/feedback-pr-panel'
import { InstructorTeamPanel } from '@/components/instructor-team-panel'
import { TeamFormationPanel } from '@/components/team-formation-panel'
import { SiteHeader } from '@/components/site-header'
import { Badge } from '@/components/ui/badge'
import { requireClassroomRole } from '@/lib/auth/dal'
import { roleSatisfies } from '@/lib/auth/roles'
import { callsPerRepo } from '@/lib/assignments/estimate'
import { db } from '@/lib/db'
import { toDateTimeLocal } from '@/lib/deadlines/format'
import { canCreateTeam, describeConstraints } from '@/lib/teams/rules'
import { estimateProvisioningMs, formatDuration, getBudgetStatus } from '@/lib/github/rateLimiter'

export default async function AssignmentPage(
  props: PageProps<'/classrooms/[slug]/assignments/[id]'>,
) {
  const { slug, id } = await props.params
  const { classroom, role, user, viaSiteAdmin } = await requireClassroomRole(slug)

  /*
   * This page is one row per student — repository, score, deadline state — or, for a
   * student, their own. A site admin who is not in the classroom has no business in
   * either view, so the break-glass role does not open it. Joining the classroom
   * from /admin/classrooms is the way in, and it is audited.
   */
  if (viaSiteAdmin) forbidden()

  const isStaff = roleSatisfies(role, 'TA')

  const assignment = await db.assignment.findFirst({
    where: { id, classroomId: classroom.id },
    select: {
      id: true,
      title: true,
      type: true,
      templateOwner: true,
      templateRepo: true,
      repoPrefix: true,
      visibility: true,
      studentPermission: true,
      deadline: true,
      lockOnDeadline: true,
      feedbackPrEnabled: true,
      autogradeEnabled: true,
      publishedAt: true,
      totalPoints: true,
    },
  })
  if (!assignment) notFound()

  // Students must not see drafts.
  if (!assignment.publishedAt && !isStaff) notFound()

  const deadlineLabel = assignment.deadline
    ? assignment.deadline.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : null

  return (
    <>
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <div>
          <Link
            href={`/classrooms/${classroom.slug}`}
            className="text-sm text-muted hover:underline"
          >
            ← {classroom.name}
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap mt-2">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold">{assignment.title}</h1>
              <p className="text-sm text-muted mt-1">
                {assignment.type === 'GROUP' ? 'Group' : 'Individual'} ·{' '}
                {deadlineLabel ? `due ${deadlineLabel}` : 'no deadline'} ·{' '}
                {assignment.templateOwner && assignment.templateRepo ? (
                  <a
                    href={`https://github.com/${assignment.templateOwner}/${assignment.templateRepo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs hover:underline"
                  >
                    {assignment.templateOwner}/{assignment.templateRepo}
                  </a>
                ) : (
                  // Stated rather than left blank: "no template" is a setting someone
                  // chose, and a missing link would read as a bug.
                  <span>no template — empty repositories</span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!assignment.publishedAt ? <Badge tone="warning">Draft</Badge> : null}
              {assignment.feedbackPrEnabled ? <Badge tone="info">Feedback PR</Badge> : null}
              {assignment.autogradeEnabled ? <Badge tone="info">Autograded</Badge> : null}
            </div>
          </div>
        </div>

        {isStaff ? (
          <StaffView assignment={assignment} classroomSlug={classroom.slug} classroomId={classroom.id} installationId={classroom.installationId} />
        ) : assignment.type === 'GROUP' ? (
          <StudentTeamView
            assignmentId={assignment.id}
            userId={user.id}
            classroomId={classroom.id}
          />
        ) : (
          <StudentView assignmentId={assignment.id} userId={user.id} classroomId={classroom.id} />
        )}
      </main>
    </>
  )
}

async function StaffView({
  assignment,
  classroomSlug,
  classroomId,
  installationId,
}: {
  assignment: {
    id: string
    title: string
    type: 'INDIVIDUAL' | 'GROUP'
    publishedAt: Date | null
    feedbackPrEnabled: boolean
    autogradeEnabled: boolean
    repoPrefix: string
    studentPermission: 'PULL' | 'PUSH' | 'MAINTAIN' | 'ADMIN'
  }
  classroomSlug: string
  classroomId: string
  installationId: bigint
}) {
  const [repos, rosterClaimed, budget] = await Promise.all([
    db.assignmentRepo.findMany({
      where: { assignmentId: assignment.id },
      select: {
        id: true,
        status: true,
        fullName: true,
        htmlUrl: true,
        failureReason: true,
        invitationId: true,
        feedbackPrNumber: true,
        acceptedAt: true,
        lastPushedAt: true,
        user: { select: { id: true, githubLogin: true, name: true } },
        team: { select: { id: true, name: true } },
        // Newest run only: the table shows current standing, and the full history
        // lives on the repository itself.
        autogradeRuns: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { score: true, maxScore: true, status: true, rawResults: true },
        },
      },
      orderBy: { acceptedAt: 'asc' },
    }),
    db.rosterEntry.count({
      where: { classroomId, removedAt: null, claimedByUserId: { not: null } },
    }),
    getBudgetStatus(installationId),
  ])

  const withoutRepo = Math.max(0, rosterClaimed - repos.filter((r) => r.user).length)
  const perRepo = callsPerRepo({
    feedbackPr: assignment.feedbackPrEnabled,
    autograde: assignment.autogradeEnabled,
  })
  const eta = formatDuration(estimateProvisioningMs(withoutRepo * perRepo))

  return (
    <>
      <StaffDeadlineSection
        assignmentId={assignment.id}
        classroomId={classroomId}
        assignmentType={assignment.type}
      />
      <StaffAutogradingSection assignmentId={assignment.id} />
      <StaffFeedbackSection assignmentId={assignment.id} />
      {assignment.type === 'GROUP' ? (
        <StaffTeamSection assignmentId={assignment.id} classroomId={classroomId} />
      ) : null}
      <AssignmentStaffPanel
        assignmentId={assignment.id}
      assignmentType={assignment.type}
      published={assignment.publishedAt !== null}
      classroomSlug={classroomSlug}
      rosterClaimed={rosterClaimed}
      withoutRepo={withoutRepo}
      estimatedDuration={eta}
      budget={{
        minuteTokens: budget.minuteTokens,
        perMinute: budget.config.perMinute,
        hourTokens: budget.hourTokens,
        perHour: budget.config.perHour,
        isBlocked: budget.isBlocked,
      }}
      repos={repos.map((r) => ({
        id: r.id,
        status: r.status,
        fullName: r.fullName,
        htmlUrl: r.htmlUrl,
        failureReason: r.failureReason,
        pendingInvitation: r.invitationId !== null,
        feedbackPrNumber: r.feedbackPrNumber,
        who: r.team ? `Team ${r.team.name}` : (r.user?.name ?? r.user?.githubLogin ?? 'Unknown'),
        githubLogin: r.user?.githubLogin ?? null,
        acceptedAt: r.acceptedAt.toISOString(),
        lastPushedAt: r.lastPushedAt ? r.lastPushedAt.toISOString() : null,
        autograde: r.autogradeRuns[0]
          ? {
              score: r.autogradeRuns[0].score,
              maxScore: r.autogradeRuns[0].maxScore,
              status: r.autogradeRuns[0].status,
              // Surfaced so a tampered manifest is visible in the table rather
              // than only in the logs.
              hasDiscrepancies:
                Array.isArray(
                  (r.autogradeRuns[0].rawResults as { discrepancies?: unknown })?.discrepancies,
                ) &&
                ((r.autogradeRuns[0].rawResults as { discrepancies: unknown[] }).discrepancies
                  .length > 0),
            }
          : null,
      }))}
      />
    </>
  )
}

/**
 * Team management for staff on a group assignment.
 *
 * Lists every team plus students who have registered but joined none — the group
 * most likely to be forgotten until the deadline.
 */
async function StaffTeamSection({
  assignmentId,
  classroomId,
}: {
  assignmentId: string
  classroomId: string
}) {
  const [teams, claimedEntries] = await Promise.all([
    db.team.findMany({
      where: { assignmentId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        githubTeamSlug: true,
        repo: {
          select: { status: true, fullName: true, htmlUrl: true, failureReason: true },
        },
        members: {
          select: {
            userId: true,
            githubMembershipState: true,
            user: { select: { name: true, githubLogin: true } },
          },
        },
      },
    }),
    db.rosterEntry.findMany({
      where: { classroomId, removedAt: null, claimedByUserId: { not: null } },
      select: {
        displayName: true,
        claimedByUserId: true,
        claimedByUser: { select: { githubLogin: true } },
      },
    }),
  ])

  const rosterNames = new Map(
    claimedEntries.map((e) => [e.claimedByUserId!, e.displayName]),
  )
  const assigned = new Set(teams.flatMap((t) => t.members.map((m) => m.userId)))

  return (
    <InstructorTeamPanel
      assignmentId={assignmentId}
      teams={teams.map((t) => ({
        id: t.id,
        name: t.name,
        githubTeamSlug: t.githubTeamSlug,
        repo: t.repo,
        members: t.members.map((m) => ({
          userId: m.userId,
          name: rosterNames.get(m.userId) ?? m.user.name ?? m.user.githubLogin ?? 'Unknown',
          githubLogin: m.user.githubLogin,
          membershipState: m.githubMembershipState,
        })),
      }))}
      unassigned={claimedEntries
        .filter((e) => !assigned.has(e.claimedByUserId!))
        .map((e) => ({
          userId: e.claimedByUserId!,
          name: e.displayName,
          githubLogin: e.claimedByUser?.githubLogin ?? null,
        }))}
    />
  )
}

async function StudentView({
  assignmentId,
  userId,
  classroomId,
}: {
  assignmentId: string
  userId: string
  classroomId: string
}) {
  const [repo, rosterEntry] = await Promise.all([
    db.assignmentRepo.findUnique({
      where: { assignmentId_userId: { assignmentId, userId } },
      select: {
        status: true,
        fullName: true,
        htmlUrl: true,
        failureReason: true,
        invitationId: true,
        feedbackPrNumber: true,
      },
    }),
    db.rosterEntry.findFirst({
      where: { classroomId, claimedByUserId: userId, removedAt: null },
      select: { id: true },
    }),
  ])

  return (
    <AssignmentStudentPanel
      assignmentId={assignmentId}
      hasRosterEntry={rosterEntry !== null}
      repo={
        repo
          ? {
              status: repo.status,
              fullName: repo.fullName,
              htmlUrl: repo.htmlUrl,
              failureReason: repo.failureReason,
              pendingInvitation: repo.invitationId !== null,
              feedbackPrNumber: repo.feedbackPrNumber,
            }
          : null
      }
    />
  )
}

/**
 * Team formation for a group assignment, from a student's perspective.
 *
 * Loads every team so a student can see who to join, but exposes only names and
 * GitHub logins — never other students' roster identifiers.
 */
async function StudentTeamView({
  assignmentId,
  userId,
  classroomId,
}: {
  assignmentId: string
  userId: string
  classroomId: string
}) {
  const [assignment, teams, rosterEntry] = await Promise.all([
    db.assignment.findUniqueOrThrow({
      where: { id: assignmentId },
      select: { maxTeams: true, maxTeamSize: true, teamNamingMode: true },
    }),
    db.team.findMany({
      where: { assignmentId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        members: {
          select: {
            userId: true,
            githubMembershipState: true,
            user: { select: { name: true, githubLogin: true } },
          },
        },
        repo: {
          select: {
            status: true,
            fullName: true,
            htmlUrl: true,
            failureReason: true,
            feedbackPrNumber: true,
          },
        },
      },
    }),
    db.rosterEntry.findFirst({
      where: { classroomId, claimedByUserId: userId, removedAt: null },
      select: { id: true },
    }),
  ])

  /**
   * Roster names, keyed by the user who claimed them.
   *
   * Teammates are shown by their roster name rather than their GitHub account
   * name: students recognise each other as the class list spells them, and a
   * GitHub display name is often a handle or absent entirely.
   */
  const rosterNames = new Map(
    (
      await db.rosterEntry.findMany({
        where: { classroomId, removedAt: null, claimedByUserId: { not: null } },
        select: { claimedByUserId: true, displayName: true },
      })
    ).map((r) => [r.claimedByUserId!, r.displayName]),
  )

  const constraints = {
    maxTeams: assignment.maxTeams,
    maxTeamSize: assignment.maxTeamSize,
    teamNamingMode: assignment.teamNamingMode,
  }

  const yourTeam = teams.find((t) => t.members.some((m) => m.userId === userId))
  const createRule = canCreateTeam(constraints, teams.length, 'STUDENT')

  return (
    <TeamFormationPanel
      assignmentId={assignmentId}
      yourTeamId={yourTeam?.id ?? null}
      constraintsText={describeConstraints(constraints)}
      canCreate={createRule.allowed}
      hasRosterClaim={rosterEntry !== null}
      teams={teams.map((t) => ({
        id: t.id,
        name: t.name,
        full:
          constraints.maxTeamSize !== null && t.members.length >= constraints.maxTeamSize,
        repo: t.repo
          ? {
              status: t.repo.status,
              fullName: t.repo.fullName,
              htmlUrl: t.repo.htmlUrl,
              failureReason: t.repo.failureReason,
              feedbackPrNumber: t.repo.feedbackPrNumber,
            }
          : null,
        members: t.members.map((m) => ({
          userId: m.userId,
          name: rosterNames.get(m.userId) ?? m.user.name ?? m.user.githubLogin ?? 'Unknown',
          githubLogin: m.user.githubLogin,
          isYou: m.userId === userId,
          membershipState: m.githubMembershipState,
        })),
      }))}
    />
  )
}

/**
 * Deadline and extension management for staff.
 *
 * Extension targets are the registered students (or the teams, for a group
 * assignment) — the only entities an extension can attach to.
 */
async function StaffDeadlineSection({
  assignmentId,
  classroomId,
  assignmentType,
}: {
  assignmentId: string
  classroomId: string
  assignmentType: 'INDIVIDUAL' | 'GROUP'
}) {
  const [assignment, extensions, lockedCount, rosterEntries, teams] = await Promise.all([
    db.assignment.findUniqueOrThrow({
      where: { id: assignmentId },
      select: { deadline: true, lockOnDeadline: true },
    }),
    db.extension.findMany({
      where: { assignmentId },
      orderBy: { newDeadline: 'asc' },
      select: {
        id: true,
        newDeadline: true,
        reason: true,
        userId: true,
        teamId: true,
        team: { select: { name: true } },
      },
    }),
    db.assignmentRepo.count({ where: { assignmentId, lockedAt: { not: null } } }),
    db.rosterEntry.findMany({
      where: { classroomId, removedAt: null, claimedByUserId: { not: null } },
      orderBy: { displayName: 'asc' },
      select: { displayName: true, claimedByUserId: true },
    }),
    assignmentType === 'GROUP'
      ? db.team.findMany({
          where: { assignmentId },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ])

  const rosterNames = new Map(rosterEntries.map((r) => [r.claimedByUserId!, r.displayName]))

  return (
    <DeadlinePanel
      assignmentId={assignmentId}
      deadline={toDateTimeLocal(assignment.deadline)}
      lockOnDeadline={assignment.lockOnDeadline}
      lockedCount={lockedCount}
      extensions={extensions.map((e) => ({
        id: e.id,
        newDeadline: e.newDeadline.toISOString(),
        reason: e.reason,
        kind: e.teamId ? ('team' as const) : ('student' as const),
        who: e.teamId
          ? (e.team?.name ?? 'a team')
          : (rosterNames.get(e.userId ?? '') ?? 'a student'),
      }))}
      targets={
        assignmentType === 'GROUP'
          ? teams.map((t) => ({ id: t.id, label: `Team ${t.name}`, kind: 'team' as const }))
          : rosterEntries.map((r) => ({
              id: r.claimedByUserId!,
              label: r.displayName,
              kind: 'student' as const,
            }))
      }
    />
  )
}

/** Autograding configuration for staff. */
async function StaffAutogradingSection({ assignmentId }: { assignmentId: string }) {
  const [assignment, repoCount] = await Promise.all([
    db.assignment.findUniqueOrThrow({
      where: { id: assignmentId },
      select: {
        autogradeEnabled: true,
        gradingTests: {
          orderBy: { order: 'asc' },
          select: {
            name: true,
            setupCommand: true,
            runCommand: true,
            timeoutMinutes: true,
            points: true,
          },
        },
      },
    }),
    db.assignmentRepo.count({ where: { assignmentId, status: 'READY' } }),
  ])

  return (
    <AutogradingPanel
      assignmentId={assignmentId}
      enabled={assignment.autogradeEnabled}
      repoCount={repoCount}
      initialTests={assignment.gradingTests.map((t) => ({
        name: t.name,
        setupCommand: t.setupCommand ?? '',
        runCommand: t.runCommand,
        timeoutMinutes: t.timeoutMinutes,
        points: t.points,
      }))}
    />
  )
}

/** Feedback pull request status for staff. */
async function StaffFeedbackSection({ assignmentId }: { assignmentId: string }) {
  const [assignment, withPr, pushedWithoutPr, awaitingFirstPush] = await Promise.all([
    db.assignment.findUniqueOrThrow({
      where: { id: assignmentId },
      select: { feedbackPrEnabled: true },
    }),
    db.assignmentRepo.count({ where: { assignmentId, feedbackPrNumber: { not: null } } }),
    db.assignmentRepo.count({
      where: {
        assignmentId,
        status: 'READY',
        feedbackPrNumber: null,
        lastPushedAt: { not: null },
      },
    }),
    db.assignmentRepo.count({
      where: { assignmentId, status: 'READY', feedbackPrNumber: null, lastPushedAt: null },
    }),
  ])

  return (
    <FeedbackPrPanel
      assignmentId={assignmentId}
      enabled={assignment.feedbackPrEnabled}
      withPr={withPr}
      pushedWithoutPr={pushedWithoutPr}
      awaitingFirstPush={awaitingFirstPush}
    />
  )
}
