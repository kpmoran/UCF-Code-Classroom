import { describe, expect, it } from 'vitest'

import { filterTemplates, type TemplateOption } from './templateMatch'

const ORG = 'ucf-code-connect-sandbox'
const t = (name: string): TemplateOption => ({ name, fullName: `${ORG}/${name}` })

const TEMPLATES: TemplateOption[] = [
  t('hw1-template'),
  t('hw2-unit-testing'),
  t('group-project-starter'),
  t('HW10-Capstone'),
  { name: 'shared-starter', fullName: 'ucf-cs-shared/shared-starter' },
]

describe('filterTemplates', () => {
  it('returns everything for an empty or whitespace query', () => {
    expect(filterTemplates(TEMPLATES, '')).toHaveLength(TEMPLATES.length)
    expect(filterTemplates(TEMPLATES, '   ')).toHaveLength(TEMPLATES.length)
  })

  it('matches a substring in the middle of the repository name', () => {
    // The whole reason this exists: every fullName starts with the org, so a
    // prefix match on "hw1" finds nothing, which is what <datalist> did.
    const names = filterTemplates(TEMPLATES, 'hw1').map((x) => x.name)
    expect(names).toContain('hw1-template')
    expect(names).toContain('HW10-Capstone')
  })

  it('is case-insensitive in both directions', () => {
    expect(filterTemplates(TEMPLATES, 'HW1-TEMPLATE').map((x) => x.name)).toEqual([
      'hw1-template',
    ])
    expect(filterTemplates(TEMPLATES, 'capstone').map((x) => x.name)).toEqual(['HW10-Capstone'])
  })

  it('matches against the owner too, so a foreign template can be found by org', () => {
    expect(filterTemplates(TEMPLATES, 'ucf-cs-shared').map((x) => x.name)).toEqual([
      'shared-starter',
    ])
  })

  it('finds a template typed as its full owner/repo', () => {
    expect(filterTemplates(TEMPLATES, `${ORG}/hw2-unit-testing`).map((x) => x.name)).toEqual([
      'hw2-unit-testing',
    ])
  })

  it('returns nothing rather than everything when there is no match', () => {
    // A silent fallback to the full list would be worse than an empty menu: it
    // reads as "these all match", and the instructor picks the wrong template.
    expect(filterTemplates(TEMPLATES, 'zzz-nonexistent')).toEqual([])
  })

  it('does not mutate or alias the input list', () => {
    const original = [...TEMPLATES]
    const all = filterTemplates(TEMPLATES, '')
    all.pop()
    expect(TEMPLATES).toEqual(original)
  })

  it('treats regex metacharacters as literal text', () => {
    // Substring matching, not pattern matching: '.' must not match any character.
    const dotted: TemplateOption[] = [t('hw.1'), t('hwX1')]
    expect(filterTemplates(dotted, 'hw.1').map((x) => x.name)).toEqual(['hw.1'])
  })
})
