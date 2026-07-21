export function makeChromeTab(
  id: number,
  url: string,
  title: string
): chrome.tabs.Tab {
  return {
    id,
    index: id - 1,
    windowId: 1,
    highlighted: false,
    active: id === 1,
    pinned: false,
    incognito: false,
    selected: id === 1,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    url,
    title,
    favIconUrl: ''
  } as chrome.tabs.Tab
}
