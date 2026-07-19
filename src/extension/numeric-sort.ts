const NUMERIC_TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true })

export function compareNumericText(left: string, right: string): number {
  return NUMERIC_TEXT_COLLATOR.compare(left, right)
}
