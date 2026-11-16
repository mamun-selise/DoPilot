import { useEffect, useState } from "react";
import { koraConfig } from "../../lib/kora/config";
import { createKoraConnection, describeHubError as describe } from "../../lib/kora/hub";

export type RunnerRepo = { key: string; github: string | null; branch?: string | null };

export type KoraUser = { sub: string; email: string | null; name: string | null };

export type TaskSummary = {
  id: string;
  repo: string;
  prompt: string;
  from: KoraUser;
  state: "Queued" | "Running" | "Succeeded" | "Failed";
  createdAt: string;
  startedAt: string | null;
};

// Mirrors RunnerView in api/Runners/Models.cs. Machine details are null for runners older than kora 0.2.2.
export type Runner = {
  id: string;
  name: string;
  machine: string | null;
  version: string | null;
  owner: KoraUser;
  repos: RunnerRepo[];
  agents: string[];
  concurrency: number;
  activeTasks: number;
  connectedAt: string;
  platform: string | null;
  nodeVersion: string | null;
  claudeVersion: string | null;
  githubAccount: string | null;
  allowBinaries: string[];
  dispatchAccept: string[];
  completedTasks: number;
  failedTasks: number;
  lastActivityAt: string | null;
  currentTasks: TaskSummary[];
};

export type HubStatus = "unconfigured" | "connecting" | "online" | "reconnecting" | "offline";

type State = { status: HubStatus; runners: Runner[]; error?: string };

// Live list of connected KORA runners. The hub pushes RunnersChanged whenever a runner connects, disconnects,
// or picks up / finishes a task.
export function useRunners() {
  const [state, setState] = useState<State>({ status: koraConfig.hubUrl ? "connecting" : "unconfigured", runners: [] });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!koraConfig.hubUrl) return;

    const connection = createKoraConnection();

    let disposed = false;
    const update = (next: Partial<State>) => {
      if (!disposed) setState((current) => ({ ...current, ...next }));
    };
    const watch = async () => update({ status: "online", runners: await connection.invoke<Runner[]>("WatchRunners"), error: undefined });

    connection.on("RunnersChanged", (runners: Runner[]) => update({ runners }));
    connection.onreconnecting(() => update({ status: "reconnecting" }));
    connection.onreconnected(() => watch().catch((error) => update({ status: "offline", error: describe(error) })));
    connection.onclose((error) => update({ status: "offline", error: error ? describe(error) : undefined }));

    update({ status: "connecting", error: undefined });
    connection
      .start()
      .then(watch)
      .catch((error) => update({ status: "offline", error: describe(error) }));

    return () => {
      disposed = true;
      void connection.stop();
    };
  }, [attempt]);

  return { ...state, retry: () => setAttempt((value) => value + 1) };
}
