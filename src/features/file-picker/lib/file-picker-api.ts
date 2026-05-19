import { invoke } from "@tauri-apps/api/core";

export interface FileMatch {
  path: string;
  rel: string;
}

export interface FileIndexStatus {
  indexed: boolean;
  count: number;
  root: string | null;
}

export const fileIndex = {
  openProject: (path: string) =>
    invoke<number>("fileindex_open_project", { path }),
  closeProject: () => invoke<void>("fileindex_close_project"),
  search: (query: string, limit = 100) =>
    invoke<FileMatch[]>("fileindex_search", { query, limit }),
  status: () => invoke<FileIndexStatus>("fileindex_status"),
};
