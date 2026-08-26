import { describe, expect, it } from 'vitest'

import { describeBoardFailure } from './operations/projects'

/**
 * The permission wording is copied verbatim from a real failure against the sandbox
 * organization, because the first attempt at this matched on a guess and silently
 * fell through to the generic branch.
 */
const REAL_PERMISSION_ERROR =
  'create project board "Probe" in ucf-code-connect-sandbox: Request failed due to ' +
  'following response errors:\n - ucf-code-connect[bot] does not have permission to ' +
  'create projects on ownerId O_kgDOEvQqaQ.'

describe('describeBoardFailure', () => {
  it('recognises the real permission error and names the remedy', () => {
    const message = describeBoardFailure(REAL_PERMISSION_ERROR)
    expect(message).toContain('Projects: write')
    expect(message).toContain('accept it on this organization')
    // The node id is noise to an instructor.
    expect(message).not.toContain('O_kgDOEvQqaQ')
  })

  it('also recognises the REST phrasing of the same problem', () => {
    expect(describeBoardFailure('Resource not accessible by integration')).toContain(
      'Projects: write',
    )
  })

  it('says which step failed, because the boards existed every time so far', () => {
    /*
     * Six real failures said "could not be created" about boards that had been
     * created seconds earlier and only failed at the sharing step — sending you to
     * look for something already there.
     */
    expect(describeBoardFailure('local rate budget exhausted (minute)', 'share')).toContain(
      'was created but could not be shared',
    )
    expect(describeBoardFailure('boom', 'create')).toContain('could not be created')
  })

  it('passes anything else through, rather than blaming permissions', () => {
    const message = describeBoardFailure('Something went wrong upstream')
    expect(message).toContain('Something went wrong upstream')
    expect(message).not.toContain('Projects: write')
  })
})
