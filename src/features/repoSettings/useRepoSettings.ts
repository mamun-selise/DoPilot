import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PullRequestRoute, usePullRequestHub } from "../pullRequests/usePullRequests";

// What kora/lib/github.js reads with `gh api repos/<repo>`. The allow_* switches are null when GitHub does not
// show them to the runner's gh account (it cannot administer the repo).
export type RepoSettings = {
  name: string;
  url: string;
  description: string;
  homepage: string;
  visibility: "public" | "private" | "internal";
  archived: boolean;
  canAdminister: boolean;
  defaultBranch: string;
  branches: string[];
  topics: string[];
  allowMergeCommit: boolean | null;
  allowSquashMerge: boolean | null;
  allowRebaseMerge: boolean | null;
  allowAutoMerge: boolean | null;
  allowUpdateBranch: boolean | null;
  deleteBranchOnMerge: boolean | null;
  hasIssues: boolean;
  hasWiki: boolean;
  hasProjects: boolean;
  hasDiscussions: boolean;
};

export type SwitchKey = {
  [K in keyof RepoSettings]: RepoSettings[K] extends boolean | null ? (K extends "archived" | "canAdminister" ? never : K) : never;
}[keyof RepoSettings];

// Only what changed, plus topic additions/removals; the runner turns it into `gh repo edit` flags.
export type SettingsChanges = Partial<Pick<RepoSettings, "description" | "homepage" | "defaultBranch" | SwitchKey>> & {
  addTopics?: string[];
  removeTopics?: string[];
};

type AskGitHub = ReturnType<typeof usePullRequestHub>["askGitHub"];

const key = (route: PullRequestRoute | undefined, repo: string | undefined) => ["repo-settings", route?.runnerId, repo];

export function useRepoSettings(askGitHub: AskGitHub, route: PullRequestRoute | undefined, repo: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: key(route, repo),
    queryFn: async () => (await askGitHub("RepositorySettings", route!.runnerId, repo!)).settings as RepoSettings,
    enabled: enabled && Boolean(route && repo),
    retry: false,
    staleTime: 60_000
  });
}

export function useSaveRepoSettings(askGitHub: AskGitHub, route: PullRequestRoute | undefined, repo: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (changes: SettingsChanges) =>
      (await askGitHub("UpdateRepositorySettings", route!.runnerId, repo!, changes)).settings as RepoSettings,
    onSuccess: (settings) => queryClient.setQueryData(key(route, repo), settings)
  });
}
