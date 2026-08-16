import type { ConditionalKeys, Simplify } from 'type-fest'

import { isUndefined, omitBy } from 'es-toolkit'

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key]
}

type RemoveNeverFields<T> = Omit<T, ConditionalKeys<Required<T>, never>>

type RemoveUndefinedFields<T extends object> = Simplify<RemoveNeverFields<Mutable<{
  [Key in keyof T as undefined extends T[Key] ? Key : never]?: Exclude<T[Key], undefined>
} & {
  [Key in keyof T as undefined extends T[Key] ? never : Key]: T[Key]
}>>>

/**
 * Copy a trusted plain object while omitting top-level fields whose value is
 * `undefined`. Other falsy values and nested references are preserved.
 *
 * `omitBy` copies own enumerable string keys into a plain object, so this is
 * not suitable for instances, symbol-keyed records, or descriptor-preserving
 * clones. For overlays, filter the optional fragment before spreading it over
 * the base; filtering a merged object can erase a base value that an
 * `undefined` patch already replaced. Keep required `unknown` fields outside
 * the candidate because `unknown` includes `undefined`.
 *
 * The assertion is the single type boundary between `omitBy`'s broad
 * `Partial<T>` result and the exact optional shape proven by the predicate.
 */
export function omitUndefined<const T extends object>(value: T): RemoveUndefinedFields<T> {
  return omitBy(value, isUndefined) as RemoveUndefinedFields<T>
}
