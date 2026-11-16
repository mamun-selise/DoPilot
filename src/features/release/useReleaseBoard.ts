import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { KoraUser } from "../runners/useRunners";
import type { PullRequest, PullRequestRoute, usePullRequestHub } from "../pullRequests/usePullRequests";

// What the runner reads from GitHub for the board: open PRs, and recently merged ones for the details of merged /
// deployed cards. Which column a PR is in is kept in Blocks Data (boardCards.ts).

export type MergedPullRequest = {
  number: number;
  title: string;
  url: string;
  author: string | null;
  head: string;
  base: string;
  mergedAt: string;
  labels: string[];
  mergeCommit: string | null;
};

export type ReleaseBoard = { open: PullRequest[]; merged: MergedPullRequest[] };

export type QueueRun = { name: string; status: string; conclusion: string | null; url: string };

// Mirrors ReleaseQueueView in api/Runners/ReleaseQueues.cs.
export type QueueItemState = "pending" | "merging" | "updating" | "building" | "deployed" | "merged" | "failed" | "skipped";
export type QueueItem = {
  number: number;
  title: string;
  state: QueueItemState;
  message: string | null;
  commit: string | null;
  runUrl: string | null;
  runs: QueueRun[] | null;
};
export type MergeQueue = {
  id: string;
  repo: string;
  runnerId: string;
  runnerName: string;
  startedBy: KoraUser;
  startedAt: string;
  finishedAt: string | null;
  method: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  items: QueueItem[];
};

type Hub = ReturnType<typeof usePullRequestHub>;

const boardKey = (route: PullRequestRoute | undefined, repo: string | undefined) => ["release-board", route?.runnerId, repo];

export function useReleaseBoard(hub: Hub, route: PullRequestRoute | undefined, repo: string | undefined) {
  return useQuery({
    queryKey: boardKey(route, repo),
    queryFn: async () => (await hub.askGitHub("ReleaseBoard", route!.runnerId, repo!)).board as ReleaseBoard,
    enabled: hub.status === "online" && Boolean(route && repo),
    retry: false,
    staleTime: 30_000,
    refetchInterval: 60_000
  });
}

// The repository's latest merge queue, live: the hub pushes MergeQueueChanged on every step, and each step also
// changes the board (a PR merged, a label added), so the board is re-read too.
export function useMergeQueue(hub: Hub, repo: string | undefined) {
  const queryClient = useQueryClient();
  const [queue, setQueue] = useState<MergeQueue | null>(null);

  useEffect(() => {
    if (hub.status !== "online" || !repo) return;
    let active = true;
    setQueue(null);
    const off = hub.on("MergeQueueChanged", (...args) => {
      const next = args[0] as MergeQueue;
      if (!active || next.repo.toLowerCase() !== repo.toLowerCase()) return;
      setQueue(next);
      void queryClient.invalidateQueries({ queryKey: ["release-board"] });
    });
    hub
      .invoke<MergeQueue | null>("WatchRelease", repo)
      .then((latest) => active && setQueue(latest))
      .catch(() => {});
    return () => {
      active = false;
      off();
      void hub.invoke("StopWatchingRelease", repo).catch(() => {});
    };
  }, [hub.status, repo]);

  return queue;
}
