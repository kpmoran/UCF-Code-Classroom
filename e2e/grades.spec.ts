import { applySession, db, expect, seedSession, test } from './fixtures'

/**
 * Gradebook and Canvas export through the browser.
 *
 * The download is fetched and its bytes inspected, because the whole feature is
 * judged by whether Canvas accepts the file — and Canvas matches students on the
 * identity columns, which must come back exactly as Canvas emitted them.
 */

const ORG = process.env.VERIFY_ORG ?? 'ucf-code-connect-sandbox'
const SLUG = 'e2egrades-fall-2026'

let classroomId: string
let assignmentId: string

/** A row shaped exactly as a Canvas Gradebook export produces it. */
function canvasRow(name: string, id: string, sis: string, nid: string) {
  return {
    Student: name,
    ID: id,
    'SIS User ID': sis,
    'SIS Login ID': nid,
    Section: 'COP4331-0001',
  }
}

async function seedClassroom() {
  await db.classroom.deleteMany({ where: { slug: SLUG } })

  const instructor = await seedSession('kpmoran', { isSiteAdmin: true })
  const classroom = await db.classroom.create({
    data: {
      name: 'E2E Grades Course',
      courseCode: 'E2EGRADE',
      term: 'Fall 2026',
      slug: SLUG,
      githubOrgLogin: ORG,
      githubOrgId: BigInt(317991529),
      installationId: BigInt(154461207),
      ownerTokenUserId: instructor.id,
      members: { create: { userId: instructor.id, role: 'INSTRUCTOR' } },
      assignments: {
        create: {
          title: 'Homework One',
          slug: 'homework-one',
          type: 'INDIVIDUAL',
          templateOwner: ORG,
          templateRepo: 'verify-template',
          repoPrefix: 'e2eg',
          autogradeEnabled: true,
          totalPoints: 100,
          publishedAt: new Date(),
          gradingTests: {
            create: [
              { name: 'Tests', runCommand: 'true', points: 100, timeoutMinutes: 5, order: 0 },
            ],
          },
        },
      },
    },
    select: { id: true, assignments: { select: { id: true } } },
  })

  classroomId = classroom.id
  assignmentId = classroom.assignments[0].id
  return { instructor }
}

/** Enrol a student and optionally give them a graded repository. */
async function addStudent(opts: {
  login: string
  name: string
  nid: string
  sis: string
  canvasId: string
  autogradeScore?: number
  manualScore?: number
  registered?: boolean
}) {
  const student = await seedSession(opts.login)

  await db.rosterEntry.create({
    data: {
      classroomId,
      displayName: opts.name,
      sisUserId: opts.sis,
      sisLoginId: opts.nid,
      rawColumns: canvasRow(opts.name, opts.canvasId, opts.sis, opts.nid),
      ...(opts.registered === false
        ? {}
        : { claimedByUserId: student.id, claimedAt: new Date() }),
    },
  })

  if (opts.registered === false) return student

  await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId, userId: student.id } },
    update: { role: 'STUDENT' },
    create: { classroomId, userId: student.id, role: 'STUDENT' },
  })

  if (opts.autogradeScore === undefined && opts.manualScore === undefined) return student

  const repo = await db.assignmentRepo.create({
    data: {
      assignmentId,
      userId: student.id,
      status: 'READY',
      fullName: `${ORG}/e2eg-${opts.nid}`,
      manualScore: opts.manualScore ?? null,
    },
    select: { id: true },
  })

  if (opts.autogradeScore !== undefined) {
    await db.autogradeRun.create({
      data: {
        assignmentRepoId: repo.id,
        workflowRunId: BigInt(Math.floor(Math.random() * 1_000_000_000) + 700_000_000),
        headSha: 'c'.repeat(40),
        status: 'COMPLETED',
        score: opts.autogradeScore,
        maxScore: 100,
      },
    })
  }

  return student
}

/** Download the export and return its text. */
async function downloadCsv(page: import('@playwright/test').Page, query = ''): Promise<string> {
  const response = await page.request.get(`/classrooms/${SLUG}/grades/export${query}`)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('text/csv')
  return response.text()
}

test.afterAll(async () => {
  await db.classroom.deleteMany({ where: { slug: SLUG } })
  await db.$disconnect()
})

test('the gradebook shows autograded scores and blank cells', async ({ page, context }) => {
  const { instructor } = await seedClassroom()
  await addStudent({
    login: 'e2e-gr-a',
    name: 'Alpha, Ann',
    nid: 'gr100001',
    sis: '50000001',
    canvasId: '6001',
    autogradeScore: 87,
  })
  await addStudent({
    login: 'e2e-gr-b',
    name: 'Beta, Ben',
    nid: 'gr100002',
    sis: '50000002',
    canvasId: '6002',
  })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/grades`)

  await expect(page.getByRole('heading', { name: 'Grades' })).toBeVisible()
  await expect(page.getByText('Homework One')).toBeVisible()
  await expect(page.getByText('87')).toBeVisible()
  // No score renders as a dash, never a zero.
  await expect(page.getByText('—').first()).toBeVisible()
})

test('an instructor overrides a score and it wins on export', async ({ page, context }) => {
  const { instructor } = await seedClassroom()
  await addStudent({
    login: 'e2e-gr-c',
    name: 'Gamma, Gil',
    nid: 'gr100003',
    sis: '50000003',
    canvasId: '6003',
    autogradeScore: 30,
  })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/grades`)

  await page.getByRole('button', { name: '30' }).click()
  const field = page.getByRole('textbox', { name: /Score for Gamma, Gil/ })
  await field.fill('95')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('button', { name: '95' })).toBeVisible()

  const repo = await db.assignmentRepo.findFirstOrThrow({ where: { assignmentId } })
  expect(repo.manualScore).toBe(95)

  // The override, not the autograded 30, reaches Canvas.
  const csv = await downloadCsv(page)
  expect(csv).toContain('"Gamma, Gil",6003,50000003,gr100003,COP4331-0001,95')
  expect(csv).not.toContain(',30')

  const audit = await db.auditLog.findFirstOrThrow({
    where: { classroomId, action: 'grade.override_set' },
  })
  expect((audit.detail as Record<string, unknown>).score).toBe(95)
})

test('clearing an override returns to the autograded score', async ({ page, context }) => {
  const { instructor } = await seedClassroom()
  await addStudent({
    login: 'e2e-gr-d',
    name: 'Delta, Dee',
    nid: 'gr100004',
    sis: '50000004',
    canvasId: '6004',
    autogradeScore: 42,
    manualScore: 99,
  })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/grades`)

  await page.getByRole('button', { name: '99' }).click()
  await page.getByRole('textbox', { name: /Score for Delta, Dee/ }).fill('')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('button', { name: '42' })).toBeVisible()

  const csv = await downloadCsv(page)
  expect(csv).toContain(',42')
})

test('the exported CSV reproduces Canvas identity columns exactly', async ({ page, context }) => {
  const { instructor } = await seedClassroom()
  // A name with a comma and quotes — the case that breaks naive CSV writing.
  await addStudent({
    login: 'e2e-gr-e',
    name: 'Smith Jr., Robert "Bob"',
    nid: 'gr100005',
    sis: '50000005',
    canvasId: '6005',
    autogradeScore: 70,
  })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/grades`)

  const csv = await downloadCsv(page)
  const lines = csv.trim().split('\r\n')

  expect(lines[0]).toBe('Student,ID,SIS User ID,SIS Login ID,Section,Homework One')
  // Quotes doubled per RFC 4180, so Canvas reads the name back intact.
  expect(lines[1]).toBe(
    '"Smith Jr., Robert ""Bob""",6005,50000005,gr100005,COP4331-0001,70',
  )
})

test('unregistered students export as blank rows, not zeros', async ({ page, context }) => {
  const { instructor } = await seedClassroom()
  await addStudent({
    login: 'e2e-gr-f',
    name: 'Echo, Eve',
    nid: 'gr100006',
    sis: '50000006',
    canvasId: '6006',
    registered: false,
  })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/grades`)

  await expect(page.getByText('not registered')).toBeVisible()

  const csv = await downloadCsv(page)
  // Trailing empty cell. A zero here would record a failing grade in Canvas for a
  // student who simply never signed up.
  expect(csv).toContain('"Echo, Eve",6006,50000006,gr100006,COP4331-0001,')
  expect(csv.trim().endsWith(',0')).toBe(false)
})

test('the Points Possible row is opt-in', async ({ page, context }) => {
  const { instructor } = await seedClassroom()
  await addStudent({
    login: 'e2e-gr-g',
    name: 'Foxtrot, Fay',
    nid: 'gr100007',
    sis: '50000007',
    canvasId: '6007',
    autogradeScore: 55,
  })

  await applySession(context, instructor)
  await page.goto(`/classrooms/${SLUG}/grades`)

  // Off by default, so an import cannot silently change the assignment's value.
  expect(await downloadCsv(page)).not.toContain('Points Possible')

  await page.getByLabel(/Include a “Points Possible” row/).check();
  const withPoints = await downloadCsv(page, '?points=1')
  expect(withPoints).toContain('"    Points Possible"')
  expect(withPoints.split('\r\n')[1]).toBe('"    Points Possible",,,,,100')
})

test('a student cannot reach the gradebook or the export', async ({ page, context }) => {
  await seedClassroom()
  const student = await addStudent({
    login: 'e2e-gr-student',
    name: 'Golf, Gus',
    nid: 'gr100008',
    sis: '50000008',
    canvasId: '6008',
    autogradeScore: 60,
  })
  await applySession(context, student)

  expect((await page.goto(`/classrooms/${SLUG}/grades`))?.status()).toBe(403)

  // The download URL is guessable from the slug, so it enforces its own check.
  const response = await page.request.get(`/classrooms/${SLUG}/grades/export`)
  expect(response.status()).toBe(403)
})
