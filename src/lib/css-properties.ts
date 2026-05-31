import type { CSSProperties } from 'react'
import type { Simplify } from 'type-fest'

export type CSSVariableProperties = Simplify<CSSProperties & {
  [property: `--${string}`]: string | number | undefined
}>
