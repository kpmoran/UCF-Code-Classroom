import { applySession, db, expect, seedSession, test } from './fixtures'

/**
 * The all-classrooms view, and the boundary it exists to make explicit.
 *
 * Site admins could always reach any classroom by URL — `requireClassroomRole` grants
 * them INSTRUCTOR as a break-glass path — but nothing listed them, so operating the
 * server meant guessing slugs or reading the database. The listing fixes that without
 * widening what an admin may read: administering an instance is a reason to see that a
 * classroom exists and to reach its configuration, not a standing licence to read
 * another course's students.
 *
 * So the interesting assertions here are the negative ones.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const SLUG = 'e2eadmlist-fall-2026'
const STUDENT_NAME = 'Verywell, Private'

let classroomId: string

async function seedColleagueClassroom() {
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  const colleague = await seedSession('e2e-adm-colleague')
  const classroom = await db.classroom.create({
    data: {
      name: 'A Colleague Course',
      courseCode: 'E2EADMLIST',
      term: 'Fall 2026',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId: BigInt(154461207),
      ownerTokenUserId: colleague.id,
      members: { create: { userId: colleague.id, role: 'INSTRUCTOR' } },
      rosterEntries: {
        create: { displayName: STUDENT_NAME, sisUserId: 'adm70001', rawColumns: {} },
      },
    },
  })
  classroomId = classroom.id
  return colleague
}

/** A site admin who is deliberately NOT a member of the classroom above. */
async function seedOutsideAdmin() {
  const admin = await seedSession('kpmoran', { isSiteAdmin: true })
  await db.classroomMember.deleteMany({ where: { classroomId, userId: admin.id } })
  return admin
}

test.afterAll(async () => {
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  await db.$disconnect()
})

test('the listing shows every classroom without naming a single student', async ({
  page,
  context,
}) => {
  await seedColleagueClassroom()
  await applySession(context, await seedOutsideAdmin())

  await page.goto('/admin/classrooms')
  await expect(page.getByRole('heading', { name: 'All classrooms' })).toBeVisible()

  const row = page.getByRole('row', { name: /A Colleague Course/ })
  await expect(row).toBeVisible()
  // Who teaches it, and how big it is — but not who is in it.
  await expect(row).toContainText('e2e-adm-colleague')
  await expect(page.getByText(STUDENT_NAME)).toHaveCount(0)
})

test('student records stay closed to an admin who is not in the classroom', async ({
  page,
  context,
}) => {
  await seedColleagueClassroom()
  await applySession(context, await seedOutsideAdmin())

  // Configuration is reachable: this is the break-glass path, and it is the reason
  // it exists — recovering a classroom nobody is left to run.
  for (const route of ['', '/settings']) {
    const ok = await page.goto(`/classrooms/${SLUG}${route}`)
    expect(ok?.status(), `GET /${route || 'overview'}`).toBe(200)
  }

  // Anything that lists people is not.
  for (const route of ['roster', 'grades', 'people', 'audit']) {
    const denied = await page.goto(`/classrooms/${SLUG}/${route}`)
    expect(denied?.status(), `GET /${route} as a non-member admin`).toBe(403)
  }
})

test('joining is one click, opens the roster, and is written to the activity log', async ({
  page,
  context,
}) => {
  await seedColleagueClassroom()
  const admin = await seedOutsideAdmin()
  await applySession(context, admin)

  await page.goto('/admin/classrooms')
  await page
    .getByRole('row', { name: /A Colleague Course/ })
    .getByRole('button', { name: /Join/ })
    .click()

  await expect(
    page.getByRole('row', { name: /A Colleague Course/ }).getByText('Joined'),
  ).toBeVisible()

  // Now a member, so the roster opens — the point being that access follows
  // membership rather than being ambient.
  const roster = await page.goto(`/classrooms/${SLUG}/roster`)
  expect(roster?.status()).toBe(200)
  await expect(page.getByText(STUDENT_NAME)).toBeVisible()

  // And it left a trace naming who did it.
  const audit = await db.auditLog.findFirst({
    where: { classroomId, action: 'classroom.admin_joined', actorUserId: admin.id },
  })
  expect(audit).not.toBeNull()
})

test('a faculty member sees nothing new', async ({ page, context }) => {
  // The whole change is scoped to site admins; an ordinary instructor must not gain
  // a view of other people's courses.
  await seedColleagueClassroom()
  const outsider = await seedSession('e2e-adm-outsider')
  await db.user.update({ where: { id: outsider.id }, data: { isFaculty: true } })
  await applySession(context, outsider)

  expect((await page.goto('/admin/classrooms'))?.status()).toBe(403)

  // And the classroom itself is not even discoverable to them.
  expect((await page.goto(`/classrooms/${SLUG}`))?.status()).toBe(404)
})
