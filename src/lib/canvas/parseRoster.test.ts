import { describe, expect, it } from 'vitest'

import {
  CANVAS_AWKWARD_NAMES,
  CANVAS_CRLF_BOM,
  CANVAS_DUPLICATE_SIS,
  CANVAS_GAPS,
  CANVAS_NO_SIS,
  CANVAS_REORDERED,
  CANVAS_STANDARD,
  EMPTY_FILE,
  HEADER_ONLY,
  NOT_A_ROSTER,
} from './fixtures'
import { parseRosterCsv, RosterParseError } from './parseRoster'

describe('parseRosterCsv — standard export', () => {
  const result = parseRosterCsv(CANVAS_STANDARD)

  it('extracts only real students', () => {
    expect(result.rows.map((r) => r.displayName)).toEqual([
      'Alvarez, Ava',
      'Bennett, Noah',
      'Chen, Mia',
    ])
  })

  it('skips the Points Possible metadata row', () => {
    expect(
      result.skipped.some((s) => s.reason.includes('Points Possible')),
    ).toBe(true)
  })

  it('skips the Student View test account', () => {
    // This account has no real GitHub user, so provisioning a repo for it would
    // always fail.
    const testStudent = result.skipped.find((s) => s.value === 'Test Student')
    expect(testStudent).toBeDefined()
    expect(testStudent?.reason).toMatch(/Student View/)
  })

  it('maps the identity columns', () => {
    expect(result.matchedColumns).toEqual({
      displayName: 'Student',
      sisUserId: 'SIS User ID',
      sisLoginId: 'SIS Login ID',
      email: null,
      section: 'Section',
    })
  })

  it('parses identity values', () => {
    expect(result.rows[0]).toMatchObject({
      displayName: 'Alvarez, Ava',
      sisUserId: '30000001',
      sisLoginId: 'av123456',
      section: 'COP4331-0001',
      email: null,
    })
  })

  it('treats assignment and score columns as passthrough', () => {
    expect(result.passthroughColumns).toEqual([
      'ID',
      'Homework 1 (901234)',
      'Project (901235)',
      'Current Score',
      'Final Score',
    ])
  })

  it('preserves every source column verbatim in rawColumns', () => {
    // This is what makes the Canvas grade *import* reproducible later.
    expect(result.rows[0].rawColumns).toEqual({
      Student: 'Alvarez, Ava',
      ID: '4001',
      'SIS User ID': '30000001',
      'SIS Login ID': 'av123456',
      Section: 'COP4331-0001',
      'Homework 1 (901234)': '9.0',
      'Project (901235)': '88.0',
      'Current Score': '92.5',
      'Final Score': '92.5',
    })
  })

  it('warns that no email column was present', () => {
    expect(result.warnings.some((w) => w.includes('No email column'))).toBe(true)
  })
})

describe('parseRosterCsv — column variation', () => {
  it('handles reordered columns and finds email', () => {
    const result = parseRosterCsv(CANVAS_REORDERED)
    expect(result.rows).toHaveLength(2)
    expect(result.matchedColumns.email).toBe('Email')
    expect(result.rows[0]).toMatchObject({
      displayName: 'Fitzgerald, Ethan',
      sisUserId: '30000006',
      sisLoginId: 'fg456789',
      email: 'fg456789@knights.ucf.edu',
    })
  })

  it('handles a missing SIS section entirely, with a warning', () => {
    const result = parseRosterCsv(CANVAS_NO_SIS)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].sisUserId).toBeNull()
    expect(result.matchedColumns.sisUserId).toBeNull()
    expect(result.warnings.some((w) => w.includes('No “SIS User ID” column'))).toBe(true)
  })

  it('matches headers regardless of case, spacing and punctuation', () => {
    const csv = 'sis_user_id,STUDENT, Section \n30000099,"Zhao, Yara",COP4331-0003\n'
    const result = parseRosterCsv(csv)
    expect(result.rows[0]).toMatchObject({
      displayName: 'Zhao, Yara',
      sisUserId: '30000099',
      section: 'COP4331-0003',
    })
  })
})

describe('parseRosterCsv — file encoding', () => {
  it('handles CRLF line endings and a UTF-8 BOM', () => {
    // A BOM left in place makes the first header "﻿Student", which silently
    // breaks name-column detection.
    const result = parseRosterCsv(CANVAS_CRLF_BOM)
    expect(result.matchedColumns.displayName).toBe('Student')
    expect(result.rows.map((r) => r.displayName)).toEqual(['Haddad, Kai', 'Ivanov, Nora'])
  })

  it('ignores blank lines between records', () => {
    const result = parseRosterCsv(CANVAS_GAPS)
    expect(result.rows.map((r) => r.displayName)).toEqual([
      'Kowalski, Priya',
      'Lindqvist, Quinn',
    ])
  })
})

describe('parseRosterCsv — awkward names', () => {
  const result = parseRosterCsv(CANVAS_AWKWARD_NAMES)

  it('keeps names intact through quoting, commas and accents', () => {
    expect(result.rows.map((r) => r.displayName)).toEqual([
      "O'Brien, Seán",
      'Müller-Schmidt, Órla',
      'de la Cruz, José María',
      '学生, 中文',
      'Smith Jr., Robert "Bob"',
    ])
  })

  it('does not lose the comma inside a quoted name', () => {
    // "Last, First" means every name contains a comma; a naive split ruins them.
    expect(result.rows[0].rawColumns['SIS Login ID']).toBe('os890123')
    expect(result.rows).toHaveLength(5)
  })
})

describe('parseRosterCsv — data problems', () => {
  it('skips a duplicate SIS User ID rather than corrupting the roster', () => {
    // Two roster entries sharing an SIS id would make grade export ambiguous.
    const result = parseRosterCsv(CANVAS_DUPLICATE_SIS)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].displayName).toBe('Jensen, Omar')

    const dup = result.skipped.find((s) => s.reason.includes('duplicate SIS User ID'))
    expect(dup).toBeDefined()
    expect(dup?.reason).toContain('Jensen, Omar')
  })

  it('reports the source line number for a skipped row', () => {
    const result = parseRosterCsv(CANVAS_DUPLICATE_SIS)
    // Header is line 1, first student line 2, duplicate line 3.
    expect(result.skipped[0].line).toBe(3)
  })

  it('warns when some students lack an SIS User ID', () => {
    const result = parseRosterCsv(CANVAS_GAPS)
    expect(result.warnings.some((w) => /1 student .*no SIS User ID/.test(w))).toBe(true)
  })

  it('never invents a missing identifier', () => {
    const result = parseRosterCsv(CANVAS_GAPS)
    const quinn = result.rows.find((r) => r.displayName === 'Lindqvist, Quinn')
    // A derived-but-wrong id could attach one student's repo to another's entry.
    expect(quinn?.sisUserId).toBeNull()
  })
})

describe('parseRosterCsv — rejection', () => {
  it('rejects an empty file with actionable guidance', () => {
    expect(() => parseRosterCsv(EMPTY_FILE)).toThrow(RosterParseError)
    expect(() => parseRosterCsv(EMPTY_FILE)).toThrow(/no header row/i)
  })

  it('rejects a file with no student name column, listing what it did find', () => {
    let message = ''
    try {
      parseRosterCsv(NOT_A_ROSTER)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/Could not find a student name column/)
    // Naming the actual headers is what makes this fixable without support.
    expect(message).toContain('Product')
  })

  it('rejects a header-only export', () => {
    expect(() => parseRosterCsv(HEADER_ONLY)).toThrow(/No student rows/i)
  })
})
