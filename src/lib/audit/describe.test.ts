import { describe, expect, it } from 'vitest'

import { describeAuditAction, isDestructiveAction } from './describe'

describe('describeAuditAction', () => {
  it('describes a roster import with its counts, including kept removals', () => {
    // The "kept" count is the important one: it records that the instructor
    // reviewed removals and chose not to apply them.
    expect(
      describeAuditAction('roster.import', {
        added: 3,
        updated: 1,
        removed: 0,
        removalsSkipped: 2,
      }),
    ).toBe(
      'Imported a Canvas roster: 3 added, 1 updated, 0 removed, 2 absent from the file but kept',
    )
  })

  it('omits the kept clause when there was nothing to keep', () => {
    expect(
      describeAuditAction('roster.import', { added: 1, updated: 0, removed: 0, removalsSkipped: 0 }),
    ).toBe('Imported a Canvas roster: 1 added, 0 updated, 0 removed')
  })

  it('states what happened to repositories on removal', () => {
    expect(describeAuditAction('member.remove', { who: 'ava-dev', repoAction: 'DELETE' })).toBe(
      'Removed ava-dev from the classroom (repositories deleted)',
    )
    expect(describeAuditAction('member.remove', { who: 'ava-dev', repoAction: 'KEEP' })).toBe(
      'Removed ava-dev from the classroom (repositories kept)',
    )
  })

  it('distinguishes a move from an initial team assignment', () => {
    expect(describeAuditAction('team.move_member', { from: 'Knights', to: 'Squires' })).toBe(
      'Moved a student from team “Knights” to “Squires”',
    )
    expect(describeAuditAction('team.move_member', { from: null, to: 'Squires' })).toBe(
      'Added a student to team “Squires”',
    )
  })

  it('mentions when an empty team was cleaned up on leaving', () => {
    expect(
      describeAuditAction('team.leave', { teamName: 'Knights', teamDeleted: true }),
    ).toContain('the empty team was removed')
    expect(
      describeAuditAction('team.leave', { teamName: 'Knights', teamDeleted: false }),
    ).not.toContain('removed')
  })

  it('surfaces partial failures in a revocation', () => {
    expect(
      describeAuditAction('github.access_revoked', {
        githubLogin: 'ava-dev',
        failures: ['org/repo: boom'],
      }),
    ).toBe('Revoked GitHub access for @ava-dev — 1 problem(s), see details')

    expect(
      describeAuditAction('github.access_revoked', { githubLogin: 'ava-dev', failures: [] }),
    ).toBe('Revoked GitHub access for @ava-dev')
  })

  it('never returns an empty description for an unknown action', () => {
    // A new action added later must still render a readable row.
    expect(describeAuditAction('some.future.action', null)).toBe('some.future.action')
  })

  it('tolerates missing or wrongly-typed detail without throwing', () => {
    for (const action of [
      'classroom.create',
      'roster.import',
      'assignment.create',
      'member.remove',
      'team.move_member',
      'github.access_revoked',
    ]) {
      expect(() => describeAuditAction(action, null)).not.toThrow()
      expect(describeAuditAction(action, null).length).toBeGreaterThan(0)
      expect(() => describeAuditAction(action, { added: 'not a number' })).not.toThrow()
    }
  })
})

describe('isDestructiveAction', () => {
  it('flags removals and revocations', () => {
    expect(isDestructiveAction('member.remove', { repoAction: 'KEEP' })).toBe(true)
    expect(isDestructiveAction('roster.unlink', null)).toBe(true)
    expect(isDestructiveAction('github.access_revoked', null)).toBe(true)
  })

  it('flags anything that deleted repositories, whatever the action', () => {
    expect(isDestructiveAction('some.other.action', { repoAction: 'DELETE' })).toBe(true)
  })

  it('does not flag ordinary activity', () => {
    expect(isDestructiveAction('assignment.create', null)).toBe(false)
    expect(isDestructiveAction('roster.claim', null)).toBe(false)
    expect(isDestructiveAction('team.join', null)).toBe(false)
  })
})
