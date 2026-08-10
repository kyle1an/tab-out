interface Distribution {
  readonly count: number
  readonly min: number
  readonly p50: number
  readonly p95: number
  readonly max: number
}

export function benchmarkCount(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error('A percentile requires measurements')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}

export function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0) return null
  return {
    count: values.length,
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  }
}

export function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}
