import { Bot, Cpu, GitBranch, RefreshCw, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { ActionButton } from "../../shared/ui/ActionButton";
import { DataTable, type Column } from "../../shared/ui/DataTable";
import { EmptyState } from "../../shared/ui/EmptyState";
import { ErrorState } from "../../shared/ui/ErrorState";
import { PageHeader } from "../../shared/ui/PageHeader";
import { Skeleton } from "../../shared/ui/Skeleton";
import { StatusPill } from "../../shared/ui/StatusPill";
import { useRunners, type HubStatus, type Runner } from "./useRunners";

const hubTone: Record<HubStatus, "good" | "warn" | "neutral"> = {
  online: "good",
  connecting: "neutral",
  reconnecting: "warn",
  offline: "warn",
  unconfigured: "neutral"
};

export function RunnersPage() {
  const { t } = useT();
  const { error, retry, runners, status } = useRunners();
  const now = useNow(30_000);

  const columns: Column<Runner>[] = [
    {
      key: "name",
      header: t("runners.col.runner"),
      render: (runner) => (
        <div>
          <strong>{runner.name}</strong>
          {runner.machine ? <div className="muted"><Cpu size={12} /> {runner.machine}</div> : null}
        </div>
      )
    },
    {
      key: "status",
      header: t("runners.col.status"),
      render: (runner) =>
        runner.activeTasks > 0 ? (
          <StatusPill tone="warn">{`${t("runners.status.busy")} ${runner.activeTasks}/${runner.concurrency}`}</StatusPill>
        ) : (
          <StatusPill tone="good">{t("runners.status.idle")}</StatusPill>
        )
    },
    { key: "owner", header: t("runners.col.owner"), render: (runner) => runner.owner.email || runner.owner.name || runner.owner.sub },
    {
      key: "repos",
      header: t("runners.col.repos"),
      render: (runner) => (
        <div className="chips">
          {runner.repos.map((repo) => (
            <span className="chip" key={repo.key} title={repo.github ?? undefined}>
              <GitBranch size={12} /> {repo.key}
              {repo.github ? <span className="muted"> · {repo.github}</span> : null}
            </span>
          ))}
        </div>
      )
    },
    {
      key: "agents",
      header: t("runners.col.agents"),
      render: (runner) => (
        <div className="chips">
          {runner.agents.length ? runner.agents.map((agent) => <span className="chip" key={agent}><Bot size={12} /> {agent}</span>) : <span className="muted">—</span>}
        </div>
      )
    },
    { key: "version", header: t("runners.col.version"), render: (runner) => <span className="mono">{runner.version ?? "—"}</span> },
    { key: "connected", header: t("runners.col.connected"), render: (runner) => <span title={new Date(runner.connectedAt).toLocaleString()}>{since(runner.connectedAt, now)}</span> }
  ];

  return (
    <section>
      <PageHeader
        title={t("runners.title")}
        subtitle={t("runners.subtitle")}
        actions={
          <>
            <StatusPill tone={hubTone[status]}>{t(`runners.hub.${status}`)}</StatusPill>
            <ActionButton variant="icon" onClick={retry} title={t("common.refresh")} icon={<RefreshCw size={18} />} />
          </>
        }
      />

      {status === "unconfigured" ? (
        <EmptyState icon={<Server size={22} />} title={t("runners.unconfigured.title")} description={t("runners.unconfigured.body")} />
      ) : status === "offline" ? (
        <ErrorState message={error || t("runners.offline")} onRetry={retry} />
      ) : status === "connecting" ? (
        <div className="panel">
          <Skeleton className="skeleton-line" />
          <Skeleton className="skeleton-line" />
        </div>
      ) : runners.length === 0 ? (
        <EmptyState icon={<Server size={22} />} title={t("runners.empty.title")} description={t("runners.empty.body")} />
      ) : (
        <DataTable columns={columns} rows={runners} />
      )}
    </section>
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function since(iso: string, now: number) {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min ago` : new Date(iso).toLocaleString();
}
