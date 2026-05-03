export type ChromeApi = typeof chrome

export function createChromeApi(chromeApi: ChromeApi = chrome): ChromeApi {
  return chromeApi
}
