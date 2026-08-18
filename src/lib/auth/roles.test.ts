import { ClassroomRole } from '@prisma/client'
import { describe, expect, it } from 'vitest'

import { ROLE_RANK, roleSatisfies } from './roles'

const { STUDENT, TA, INSTRUCTOR } = ClassroomRole

describe('roleSatisfies', () => {
  it('lets a role satisfy itself', () => {
    expect(roleSatisfies(STUDENT, STUDENT)).toBe(true)
    expect(roleSatisfies(TA, TA)).toBe(true)
    expect(roleSatisfies(INSTRUCTOR, INSTRUCTOR)).toBe(true)
  })

  it('lets higher roles satisfy lower requirements', () => {
    // The bug this guards against: an instructor being refused a TA-gated page.
    expect(roleSatisfies(INSTRUCTOR, TA)).toBe(true)
    expect(roleSatisfies(INSTRUCTOR, STUDENT)).toBe(true)
    expect(roleSatisfies(TA, STUDENT)).toBe(true)
  })

  it('does not let lower roles satisfy higher requirements', () => {
    expect(roleSatisfies(STUDENT, TA)).toBe(false)
    expect(roleSatisfies(STUDENT, INSTRUCTOR)).toBe(false)
    expect(roleSatisfies(TA, INSTRUCTOR)).toBe(false)
  })

  it('ranks every role in the enum', () => {
    // A new role added to the schema without a rank would silently compare as
    // undefined and fail every check; this catches that at test time.
    for (const role of Object.values(ClassroomRole)) {
      expect(typeof ROLE_RANK[role]).toBe('number')
    }
  })
})
