import 'dotenv/config'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'node:crypto'

/**
 * Development seed: one classroom with a roster and two assignments, so the UI
 * has something to render before a GitHub App is connected.
 *
 * Deliberately does NOT create anything on GitHub. Every repo here is left in
 * QUEUED with no fullName, which is exactly the state a real repo occupies
 * before the provisioning worker picks it up.
 */

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.')
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

const FIRST_NAMES = [
  'Ava', 'Noah', 'Mia', 'Liam', 'Zoe', 'Ethan', 'Ivy', 'Kai', 'Nora', 'Omar',
  'Priya', 'Quinn', 'Ravi', 'Sofia', 'Theo', 'Uma', 'Victor', 'Wren', 'Xiu',
  'Yara', 'Zane', 'Amara', 'Bodhi', 'Clara', 'Dmitri', 'Elena', 'Farid',
  'Greta', 'Hana', 'Idris',
]
const LAST_NAMES = [
  'Alvarez', 'Bennett', 'Chen', 'Duarte', 'Eriksen', 'Fitzgerald', 'Gupta',
  'Haddad', 'Ivanov', 'Jensen', 'Kowalski', 'Lindqvist', 'Mbeki', 'Nakamura',
  'Okonkwo', 'Petrov', 'Qureshi', 'Rossi', 'Silva', 'Tanaka', 'Ustinov',
  'Vargas', 'Wong', 'Xu', 'Yilmaz', 'Zhao', 'Abebe', 'Brandt', 'Costa', 'Dupont',
]

async function main() {
  console.log('Seeding development data...')

  // Idempotent: wiping the classroom cascades to roster, assignments, repos.
  await db.classroom.deleteMany({ where: { slug: 'cop4331-fall-2026' } })

  const instructor = await db.user.upsert({
    where: { githubLogin: 'seed-instructor' },
    update: {},
    create: {
      githubId: '900000001',
      githubLogin: 'seed-instructor',
      name: 'Dr. Instructor (seed)',
      email: 'instructor@seed.invalid',
      isSiteAdmin: true,
    },
  })

  const classroom = await db.classroom.create({
    data: {
      name: 'Processes for Object-Oriented Software Development',
      courseCode: 'COP4331',
      term: 'Fall 2026',
      slug: 'cop4331-fall-2026',
      // Placeholder org values; replaced when a real classroom is created
      // against an actual GitHub App installation.
      githubOrgLogin: 'ucf-code-connect-sandbox',
      githubOrgId: BigInt(1),
      installationId: BigInt(1),
      ownerTokenUserId: instructor.id,
      members: {
        create: { userId: instructor.id, role: 'INSTRUCTOR' },
      },
      inviteLinks: {
        create: {
          token: randomBytes(24).toString('base64url'),
          maxUses: 200,
        },
      },
    },
    include: { inviteLinks: true },
  })

  // A roster shaped like a real Canvas Gradebook export, including the
  // rawColumns payload that grade export later reads back.
  const rosterData = Array.from({ length: 30 }, (_, i) => {
    const first = FIRST_NAMES[i % FIRST_NAMES.length]
    const last = LAST_NAMES[i % LAST_NAMES.length]
    const displayName = `${last}, ${first}`
    const nid = `nid${String(100000 + i * 7)}`
    const sisUserId = String(30000000 + i * 13)
    const section = i % 3 === 0 ? 'COP4331-0001' : 'COP4331-0002'

    return {
      classroomId: classroom.id,
      displayName,
      sisUserId,
      sisLoginId: nid,
      email: `${nid}@knights.ucf.edu`,
      section,
      rawColumns: {
        Student: displayName,
        ID: String(4000000 + i),
        'SIS User ID': sisUserId,
        'SIS Login ID': nid,
        Section: section,
      },
    }
  })

  await db.rosterEntry.createMany({ data: rosterData })

  const individual = await db.assignment.create({
    data: {
      classroomId: classroom.id,
      title: 'Homework 1 — Unit Testing',
      slug: 'hw1-unit-testing',
      type: 'INDIVIDUAL',
      templateOwner: 'ucf-code-connect-sandbox',
      templateRepo: 'hw1-template',
      repoPrefix: 'hw1',
      deadline: new Date('2026-09-15T23:59:00Z'),
      feedbackPrEnabled: true,
      autogradeEnabled: true,
      totalPoints: 100,
      publishedAt: new Date(),
      gradingTests: {
        create: [
          {
            name: 'Compiles',
            setupCommand: 'npm ci',
            runCommand: 'npm run build',
            points: 20,
            order: 0,
          },
          {
            name: 'Unit tests',
            runCommand: 'npm test',
            points: 80,
            order: 1,
            timeoutMinutes: 15,
          },
        ],
      },
    },
  })

  const group = await db.assignment.create({
    data: {
      classroomId: classroom.id,
      title: 'Group Project — Milestone 1',
      slug: 'project-milestone-1',
      type: 'GROUP',
      templateOwner: 'ucf-code-connect-sandbox',
      templateRepo: 'project-template',
      repoPrefix: 'project-m1',
      deadline: new Date('2026-10-20T23:59:00Z'),
      maxTeams: 10,
      maxTeamSize: 4,
      teamNamingMode: 'STUDENT_CHOSEN',
      totalPoints: 200,
      publishedAt: new Date(),
    },
  })

  // Claim the first three roster entries with fake student accounts and queue
  // their repos, so the assignment overview has non-empty rows to render.
  const claimed = await db.rosterEntry.findMany({
    where: { classroomId: classroom.id },
    orderBy: { displayName: 'asc' },
    take: 3,
  })

  for (const [i, entry] of claimed.entries()) {
    const login = `seed-student-${i + 1}`
    const student = await db.user.upsert({
      where: { githubLogin: login },
      update: {},
      create: {
        githubId: String(900000100 + i),
        githubLogin: login,
        name: entry.displayName,
        email: entry.email,
      },
    })

    await db.rosterEntry.update({
      where: { id: entry.id },
      data: { claimedByUserId: student.id, claimedAt: new Date() },
    })

    await db.classroomMember.create({
      data: { classroomId: classroom.id, userId: student.id, role: 'STUDENT' },
    })

    await db.assignmentRepo.create({
      data: { assignmentId: individual.id, userId: student.id, status: 'QUEUED' },
    })
  }

  console.log(`
Seed complete.

  Classroom:   ${classroom.name} (${classroom.slug})
  Roster:      ${rosterData.length} entries, 3 claimed
  Assignments: ${individual.title}
               ${group.title}
  Invite link: ${process.env.APP_URL ?? 'http://localhost:3000'}/join/${classroom.inviteLinks[0].token}

The GitHub org/installation ids are placeholders — no GitHub resources were
created. Create a real classroom once your GitHub App is installed.
`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
