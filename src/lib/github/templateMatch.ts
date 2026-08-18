export type TemplateOption = { fullName: string; name: string }

/**
 * Filter template repositories against what the instructor has typed.
 *
 * Pure, and separate from the combobox, because this is where the behaviour that
 * matters lives — the component around it is wiring.
 *
 * Matches on a **substring** of either the repository name or the full
 * `owner/repo`. Prefix matching, which is what a native `<datalist>` does, is
 * useless here: every candidate begins with the organization login, so typing
 * `hw1` matches nothing at all even though `ucf-code-connect-sandbox/hw1-template`
 * is sitting right there. `hw1` is the only thing anyone would type.
 */
export function filterTemplates(
  templates: readonly TemplateOption[],
  query: string,
): TemplateOption[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...templates]

  return templates.filter(
    (t) => t.name.toLowerCase().includes(q) || t.fullName.toLowerCase().includes(q),
  )
}
