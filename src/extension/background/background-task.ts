export async function settleBackgroundTask(task: () => Promise<unknown>): Promise<void> {
  try {
    await task()
  } catch {}
}
