import type { CSSProperties } from 'react'

export type CSSVariableProperties = CSSProperties & {
  [property: `--${string}`]: string | number | undefined
}
