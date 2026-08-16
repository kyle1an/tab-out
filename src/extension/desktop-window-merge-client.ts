import {
  DESKTOP_WINDOW_MERGE_ACKNOWLEDGE_MESSAGE,
  DESKTOP_WINDOW_MERGE_CONFIRM_MESSAGE,
  DESKTOP_WINDOW_MERGE_PREVIEW_MESSAGE,
  DESKTOP_WINDOW_MERGE_STATUS_GET_MESSAGE,
  parseDesktopWindowMergeAcknowledgeResponse,
  parseDesktopWindowMergeConfirmResponse,
  parseDesktopWindowMergePreviewResponse,
  parseDesktopWindowMergeStatusResponse,
  type DesktopWindowMergeConfirmResponse,
  type DesktopWindowMergePreviewResponse,
  type DesktopWindowMergeStatusResponse,
} from './desktop-window-merge-contract.js'

async function sendMessage(message: unknown): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage(message)
  } catch {
    return null
  }
}

export async function getDesktopWindowMergeStatus(): Promise<
  DesktopWindowMergeStatusResponse | null
> {
  return parseDesktopWindowMergeStatusResponse(await sendMessage({
    type: DESKTOP_WINDOW_MERGE_STATUS_GET_MESSAGE,
  }))
}

export async function previewDesktopWindowMerge(): Promise<
  DesktopWindowMergePreviewResponse | null
> {
  return parseDesktopWindowMergePreviewResponse(await sendMessage({
    type: DESKTOP_WINDOW_MERGE_PREVIEW_MESSAGE,
  }))
}

export async function confirmDesktopWindowMerge(
  previewId: string,
): Promise<DesktopWindowMergeConfirmResponse | null> {
  return parseDesktopWindowMergeConfirmResponse(await sendMessage({
    type: DESKTOP_WINDOW_MERGE_CONFIRM_MESSAGE,
    previewId,
  }))
}

export async function acknowledgeDesktopWindowMerge(
  sessionId: string,
): Promise<boolean> {
  const response = parseDesktopWindowMergeAcknowledgeResponse(await sendMessage({
    type: DESKTOP_WINDOW_MERGE_ACKNOWLEDGE_MESSAGE,
    sessionId,
  }))
  return response?.ok === true
}
