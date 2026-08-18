/**
 * Canvas Gradebook export fixtures.
 *
 * Shaped after real exports: quoted "Last, First" names, the indented
 * "Points Possible" metadata row, the Student View test account, assignment
 * columns with their Canvas ids in parentheses, and the trailing score columns.
 */

/** A typical export with SIS data and two assignments. */
export const CANVAS_STANDARD = `"Student","ID","SIS User ID","SIS Login ID","Section","Homework 1 (901234)","Project (901235)","Current Score","Final Score"
"    Points Possible","","","","","10.0","100.0","(read only)","(read only)"
"Alvarez, Ava","4001","30000001","av123456","COP4331-0001","9.0","88.0","92.5","92.5"
"Bennett, Noah","4002","30000002","nb234567","COP4331-0001","10.0","91.0","95.0","95.0"
"Chen, Mia","4003","30000003","mc345678","COP4331-0002","8.5","79.0","81.0","81.0"
"Test Student","4999","","","COP4331-0001","","","",""
`

/** No SIS columns — what an instructor without SIS permission gets. */
export const CANVAS_NO_SIS = `"Student","ID","Section","Homework 1 (901234)"
"    Points Possible","","","10.0"
"Duarte, Liam","4004","COP4331-0001","7.0"
"Eriksen, Zoe","4005","COP4331-0002","9.5"
`

/** Columns reordered and renamed, with an email column present. */
export const CANVAS_REORDERED = `"SIS Login ID","Email","Student","Section","SIS User ID","ID"
"fg456789","fg456789@knights.ucf.edu","Fitzgerald, Ethan","COP4331-0001","30000006","4006"
"gh567890","gh567890@knights.ucf.edu","Gupta, Ivy","COP4331-0002","30000007","4007"
`

/** CRLF line endings and a UTF-8 BOM, as produced by some browsers on Windows. */
export const CANVAS_CRLF_BOM =
  '﻿"Student","ID","SIS User ID","SIS Login ID","Section"\r\n' +
  '"    Points Possible","","","",""\r\n' +
  '"Haddad, Kai","4008","30000008","hk678901","COP4331-0001"\r\n' +
  '"Ivanov, Nora","4009","30000009","in789012","COP4331-0002"\r\n'

/** Names with commas, quotes, apostrophes, accents and non-Latin scripts. */
export const CANVAS_AWKWARD_NAMES = `"Student","ID","SIS User ID","SIS Login ID","Section"
"O'Brien, Seán","4010","30000010","os890123","COP4331-0001"
"Müller-Schmidt, Órla","4011","30000011","mo901234","COP4331-0001"
"de la Cruz, José María","4012","30000012","dj012345","COP4331-0002"
"学生, 中文","4013","30000013","zz123450","COP4331-0002"
"Smith Jr., Robert ""Bob""","4014","30000014","sr234501","COP4331-0001"
`

/** Two rows sharing one SIS User ID — a genuine Canvas data problem. */
export const CANVAS_DUPLICATE_SIS = `"Student","ID","SIS User ID","SIS Login ID","Section"
"Jensen, Omar","4015","30000015","jo345612","COP4331-0001"
"Jensen, Omar (duplicate)","4016","30000015","jo345612b","COP4331-0001"
`

/** Blank lines interspersed, and a row with a missing SIS User ID. */
export const CANVAS_GAPS = `"Student","ID","SIS User ID","SIS Login ID","Section"
"    Points Possible","","","",""

"Kowalski, Priya","4017","30000017","kp456723","COP4331-0001"

"Lindqvist, Quinn","4018","","lq567834","COP4331-0002"
`

/** Not a roster at all. */
export const NOT_A_ROSTER = `"Product","Price","Quantity"
"Widget","9.99","3"
`

export const EMPTY_FILE = ''

/** Header only, no student rows. */
export const HEADER_ONLY = `"Student","ID","SIS User ID","SIS Login ID","Section"
"    Points Possible","","","",""
`
