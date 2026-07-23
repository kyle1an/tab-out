export type ExclusiveTaskRunner = <Value>(
  task: () => Promise<Value>
) => Promise<Value>

export function runWithWebLock<Value>(
  name: string,
  task: () => Promise<Value>
): Promise<Value> {
  return navigator.locks.request(name, task)
}
