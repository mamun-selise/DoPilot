import type { HubConnection } from "@microsoft/signalr";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { koraConfig } from "../../lib/kora/config";
import { createKoraConnection, describeHubError } from "../../lib/kora/hub";
import type { HubStatus, KoraUser } from "../runners/useRunners";

// Mirrors PullRequestRepo / PullRequestRoute in api/Runners/Models.cs.
export type PullRequestRoute = { runnerId: string; runnerName: string; owner: KoraUser; githubAccount: string | null };
export type PullRequestRepo = { github: string; runners: PullRequestRoute[] };

// What kora/lib/github.js reports for each open pull request (gh pr list).
export type PullRequest = {
  number: number;
  title: string;
  url: string;
  author: string | null;
  isDraft: boolean;
  head: string;
  base: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
  mergeState: string | null;
  checks: { passed: number; failed: number; pending: number };
};

export type MergeMethod = "merge" | "squash" | "rebase";

type GitHubAnswer = { ok: boolean; error?: string | null; pullRequests?: PullRequest[] };

type State = { status: HubStatus; repos: PullRequestRepo[]; error?: string };

// Repositories reachable through runners the user may use, kept live: the hub pushes RunnersChanged whenever a
// runner connects or disconnects, and the list is asked for again. The GitHub work itself runs on a runner (gh).
export function usePullRequestHub() {
  const [state, setState] = useState<State>({ status: koraConfig.hubUrl ? "connecting" : "unconfigured", repos: [] });
  const [attempt, setAttempt] = useState(0);
  const connectionRef = useRef<HubConnection | null>(null);

  useEffect(() => {
    if (!koraConfig.hubUrl) return;

    const connection = createKoraConnection();
    connectionRef.current = connection;
    let disposed = false;
    const update = (next: Partial<State>) => {
      if (!disposed) setState((current) => ({ ...current, ...next }));
    };
    const loadRepos = async () => update({ repos: await connection.invoke<PullRequestRepo[]>("PullRequestRepos") });
    const watch = async () => {
      await connection.invoke("WatchRunners"); // joins the group that receives RunnersChanged
      await loadRepos();
      update({ status: "online", error: undefined });
    };
    const fail = (error: unknown) => update({ status: "offline", error: describeHubError(error) });

    connection.on("RunnersChanged", () => void loadRepos().catch(() => {}));
    connection.onreconnecting(() => update({ status: "reconnecting" }));
    connection.onreconnected(() => watch().catch(fail));
    connection.onclose((error) => update({ status: "offline", error: error ? describeHubError(error) : undefined }));

    update({ status: "connecting", error: undefined });
    connection.start().then(watch).catch(fail);

    return () => {
      disposed = true;
      connectionRef.current = null;
      void connection.stop();
    };
  }, [attempt]);

  // Asks a runner to run gh; its { ok: false, error } answers become thrown errors.
  const askGitHub = useCallback(async (method: string, ...args: unknown[]) => {
    const connection = connectionRef.current;
    if (!connection) throw new Error("Not connected to the KORA backend.");
    let answer: GitHubAnswer;
    try {
      answer = await connection.invoke<GitHubAnswer>(method, ...args);
    } catch (error) {
      throw new Error(describeHubError(error));
    }
    if (!answer?.ok) throw new Error(answer?.error || "The runner could not complete the request.");
    return answer;
  }, []);

  return { ...state, askGitHub, retry: () => setAttempt((value) => value + 1) };
}

type AskGitHub = ReturnType<typeof usePullRequestHub>["askGitHub"];

export function useOpenPullRequests(askGitHub: AskGitHub, route: PullRequestRoute | undefined, repo: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["pull-requests", route?.runnerId, repo],
    queryFn: async () => (await askGitHub("ListPullRequests", route!.runnerId, repo!)).pullRequests ?? [],
    enabled: enabled && Boolean(route && repo),
    retry: false,
    staleTime: 30_000,
    refetchInterval: 60_000
  });
}

export function useApprovePullRequest(askGitHub: AskGitHub) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ route, repo, number, body }: { route: PullRequestRoute; repo: string; number: number; body: string }) =>
      askGitHub("ApprovePullRequest", route.runnerId, repo, number, body || null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pull-requests"] })
  });
}

export function useMergePullRequest(askGitHub: AskGitHub) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ route, repo, number, method, deleteBranch }: { route: PullRequestRoute; repo: string; number: number; method: MergeMethod; deleteBranch: boolean }) =>
      askGitHub("MergePullRequest", route.runnerId, repo, number, method, deleteBranch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pull-requests"] })
  });
}
