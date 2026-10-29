import { describe, expect, it } from 'vitest'

import { teamLabel } from './label'

describe('teamLabel', () => {
  it('prefixes a bare name', () => {
    expect(teamLabel('Knights')).toBe('Team Knights')
  })

  it('leaves a name that already starts with "Team" alone, whatever the case', () => {
    expect(teamLabel('Team 3')).toBe('Team 3')
    expect(teamLabel('team rocket')).toBe('team rocket')
    expect(teamLabel('TEAM 10')).toBe('TEAM 10')
  })

  it('only treats "Team" as a prefix when it is a whole word', () => {
    expect(teamLabel('Teamsters')).toBe('Team Teamsters')
  })

  it('ignores surrounding whitespace when deciding', () => {
    expect(teamLabel('  Team 7 ')).toBe('Team 7')
  })
})
