import { describe, expect, it } from 'vitest'

import { callsPerRepo } from './estimate'

describe('callsPerRepo', () => {
  it('counts generation plus the collaborator invitation', () => {
    expect(callsPerRepo({ feedbackPr: false, autograde: false })).toBe(2)
  })

  it('adds the feedback pull request ref and PR', () => {
    expect(callsPerRepo({ feedbackPr: true, autograde: false })).toBe(4)
  })

  it('adds the autograding workflow commit', () => {
    expect(callsPerRepo({ feedbackPr: false, autograde: true })).toBe(3)
  })

  it('counts everything when both are enabled', () => {
    expect(callsPerRepo({ feedbackPr: true, autograde: true })).toBe(5)
  })

  it('scales an ETA to something worth warning about', () => {
    // 200 students with every extra enabled is 1000 content-creating calls,
    // twice GitHub's hourly allowance — the number the ETA must convey.
    expect(200 * callsPerRepo({ feedbackPr: true, autograde: true })).toBe(1000)
  })
})
