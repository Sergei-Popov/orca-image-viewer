// Plural forms by the language's own rules: "1 tile", "2 tiles"; "1 плитка", "3 плитки", "5 плиток".

const rules = new Map<string, Intl.PluralRules>()

export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }

/** The word for `n` things in `locale`, from its plural forms (`other` when a form is missing). */
export function plural(locale: string, n: number, forms: PluralForms): string {
  let r = rules.get(locale)
  if (!r) rules.set(locale, (r = new Intl.PluralRules(locale)))
  return forms[r.select(n)] ?? forms.other
}

/** "1 tile", "24 tiles": a count and its word in English. */
export function count(n: number, one: string, other = `${one}s`): string {
  return `${n} ${plural('en', n, { one, other })}`
}
