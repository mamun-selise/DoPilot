import { Bot, ChevronDown, ChevronRight, Cpu, GitBranch, RefreshCw, Server } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { ActionButton } from "../../shared/ui/ActionButton";
import { EmptyState } from "../../shared/ui/EmptyState";
import { ErrorState } from "../../shared/ui/ErrorState";
import { PageHeader } from "../../shared/ui/PageHeader";
import { Skeleton } from "../../shared/ui/Skeleton";
import { StatusPill } from "../../shared/ui/StatusPill";
import { useRunners, type HubStatus, type KoraUser, type Runner } from "./useRunners";

const hubTone: Record<HubStatus, "good" | "warn" | "neutral"> = {
  online: "good",
  connecting: "neutral",
  reconnecting: "warn",
  offline: "warn",
  unconfigured: "neutral"
};

const COLUMN_COUNT = 9;

export function RunnersPage() {
  const { t } = useT();
  const { error, retry, runners, status } = useRunners();
  const now = useNow(30_000);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section className="wide">
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
        <>
          <Summary runners={runners} />
          <div className="table-shell">
            <table className="runners-table">
              <thead>
                <tr>
                  <th className="runner-expand" aria-label={t("runners.col.details")} />
                  <th>{t("runners.col.runner")}</th>
                  <th>{t("runners.col.status")}</th>
                  <th>{t("runners.col.owner")}</th>
                  <th>{t("runners.col.repos")}</th>
                  <th>{t("runners.col.agents")}</th>
                  <th>{t("runners.col.tasks")}</th>
                  <th>{t("runners.col.version")}</th>
                  <th>{t("runners.col.connected")}</th>
                </tr>
              </thead>
              <tbody>
                {runners.map((runner) => {
                  const open = expanded.has(runner.id);
                  return (
                    <Fragment key={runner.id}>
                      <tr>
                        <td className="runner-expand">
                          <button
                            className="icon-button"
                            onClick={() => toggle(runner.id)}
                            aria-expanded={open}
                            aria-label={t("runners.col.details")}
                            title={t("runners.col.details")}
                          >
                            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </button>
                        </td>
                        <td>
                          <div className="runner-stack">
                            <strong>{runner.name}</strong>
                            {runner.machine ? <span className="muted"><Cpu size={12} /> {runner.machine}</span> : null}
                            {runner.platform ? <span className="muted">{runner.platform}</span> : null}
                          </div>
                        </td>
                        <td>
                          <div className="runner-stack">
                            {runner.activeTasks > 0 ? (
                              <StatusPill tone="warn">{`${t("runners.status.busy")} ${runner.activeTasks}/${runner.concurrency}`}</StatusPill>
                            ) : (
                              <StatusPill tone="good">{t("runners.status.idle")}</StatusPill>
                            )}
                            {runner.currentTasks.map((task) => (
                              <div className="runner-task" key={task.id} title={task.prompt}>
                                <strong>{task.repo}</strong> · {task.prompt}
                                <div className="muted">
                                  {task.state === "Queued" ? t("runners.task.queued") : t("runners.task.running")} · {userLabel(task.from)}
                                  {task.startedAt ? ` · ${since(task.startedAt, now)}` : ""}
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                        <td>
                          <div className="runner-stack">
                            <span>{runner.owner.name || userLabel(runner.owner)}</span>
                            {runner.owner.name && runner.owner.email ? <span className="muted">{runner.owner.email}</span> : null}
                          </div>
                        </td>
                        <td>
                          <div className="runner-stack">
                            {runner.repos.map((repo) => (
                              <div className="runner-repo" key={repo.key}>
                                <span className="runner-key">{repo.key}</span>
                                {repo.github ? (
                                  <a href={`https://github.com/${repo.github}`} target="_blank" rel="noreferrer">{repo.github}</a>
                                ) : (
                                  <span className="muted">{t("runners.repo.noRemote")}</span>
                                )}
                                {repo.branch ? <span className="muted"><GitBranch size={12} /> {repo.branch}</span> : null}
                                {repo.local === false ? <span className="muted">{t("repos.githubOnly")}</span> : null}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td>
                          <div className="chips">
                            {runner.agents.length ? (
                              runner.agents.map((agent) => (
                                <span className="chip" key={agent}>
                                  <Bot size={12} /> {agent}
                                  {agent === "claude" && runner.claudeVersion ? <span className="muted">{runner.claudeVersion}</span> : null}
                                </span>
                              ))
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="runner-stack">
                            <span>{fill(t("runners.tasks.counts"), { done: runner.completedTasks, failed: runner.failedTasks })}</span>
                            <span className="muted">
                              {runner.lastActivityAt ? `${t("runners.tasks.last")} ${since(runner.lastActivityAt, now)}` : t("runners.tasks.none")}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="runner-stack">
                            <span className="mono">{runner.version ?? "—"}</span>
                            {runner.nodeVersion ? <span className="muted">Node {runner.nodeVersion}</span> : null}
                          </div>
                        </td>
                        <td title={new Date(runner.connectedAt).toLocaleString()}>{since(runner.connectedAt, now)}</td>
                      </tr>
                      {open ? (
                        <tr className="runner-details">
                          <td colSpan={COLUMN_COUNT}>
                            <Details runner={runner} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Summary({ runners }: { runners: Runner[] }) {
  const { t } = useT();
  const busy = runners.filter((runner) => runner.activeTasks > 0).length;
  const owners = new Set(runners.map((runner) => runner.owner.sub)).size;
  const done = runners.reduce((sum, runner) => sum + runner.completedTasks, 0);
  const failed = runners.reduce((sum, runner) => sum + runner.failedTasks, 0);
  const metrics: [string, number][] = [
    [t("runners.summary.online"), runners.length],
    [t("runners.summary.busy"), busy],
    [t("runners.summary.idle"), runners.length - busy],
    [t("runners.summary.developers"), owners],
    [t("runners.summary.done"), done],
    [t("runners.summary.failed"), failed]
  ];
  return (
    <div className="runners-summary">
      {metrics.map(([label, value]) => (
        <div className="panel" key={label}>
          <span className="muted">{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function Details({ runner }: { runner: Runner }) {
  const { t } = useT();
  return (
    <div className="runner-details-grid">
      <div>
        <h4>{t("runners.details.commands")}</h4>
        <div className="chips">
          {runner.allowBinaries.length ? (
            runner.allowBinaries.map((bin) => <span className="chip mono" key={bin}>{bin}</span>)
          ) : (
            <span className="muted">{runner.version && runner.platform ? t("runners.details.noCommands") : t("runners.details.unknown")}</span>
          )}
        </div>
      </div>
      <div>
        <h4>{t("runners.details.accepts")}</h4>
        <div className="chips">
          <span className="chip">{t("runners.details.owner")}</span>
          {runner.dispatchAccept.map((who) => <span className="chip" key={who}>{who}</span>)}
        </div>
      </div>
      <div>
        <h4>{t("runners.details.github")}</h4>
        <span>{runner.githubAccount ?? "—"}</span>
      </div>
      <div>
        <h4>{t("runners.details.concurrency")}</h4>
        <span>{fill(t("runners.details.concurrencyValue"), { count: runner.concurrency })}</span>
      </div>
      <div>
        <h4>{t("runners.details.id")}</h4>
        <span className="mono">{runner.id}</span>
      </div>
    </div>
  );
}

// t() has no parameters, so translated strings carry {name} placeholders filled here.
function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

function userLabel(user: KoraUser) {
  return user.email || user.name || user.sub;
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
