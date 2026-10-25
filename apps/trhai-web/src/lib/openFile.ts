import { apiPost, type ApiResult } from "./api";

// Asking the API to open a file in the workspace on this PC, or to show where it
// is. The API does it on its own side, in the user's session, and refuses
// anything that is not a place in the workspace or a kind of file that is safe
// to hand to the program it belongs to.

export type FileAction = "open" | "reveal";

export function openOnThisPc(path: string, action: FileAction): Promise<ApiResult<{ action: FileAction; path: string }>> {
  return apiPost<{ action: FileAction; path: string }>("/v1/files/open", { path, action });
}
