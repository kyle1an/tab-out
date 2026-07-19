export async function readChromeStorageValue(
  storage: chrome.storage.StorageArea,
  key: string
): Promise<unknown> {
  const stored = await storage.get(key)
  return stored[key]
}

export async function writeChromeStorageValue(
  storage: chrome.storage.StorageArea,
  key: string,
  value: unknown
): Promise<void> {
  await storage.set({ [key]: value })
}

export async function writeChromeStorageValueBestEffort(
  storage: chrome.storage.StorageArea,
  key: string,
  value: unknown
): Promise<void> {
  try {
    await writeChromeStorageValue(storage, key, value)
  } catch (error) {
    console.warn('Tab Out background best-effort storage write failed', key, error)
  }
}
