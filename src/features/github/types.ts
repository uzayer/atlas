// Wire shapes for the GitHub commands (Rust `commands/github.rs`, snake_case,
// no serde rename). Shared by the GitHub panel and the composer's "Add from
// GitHub" submenu so the two can't drift.

/** A `search_github` result row. */
export interface GithubRepo {
  name: string;
  full_name: string;
  description: string;
  html_url: string;
  clone_url: string;
  language: string;
  stars: number;
  forks: number;
  updated_at: string;
}

/** A repo already cloned under `<project>/.atlas/repos` (`list_cloned_repos`).
 *  `name` is the on-disk dir (`owner-repo`) — the value passed as `repoName`
 *  when cloning. */
export interface ClonedRepo {
  name: string;
  display_name: string;
  path: string;
  has_readme: boolean;
}
