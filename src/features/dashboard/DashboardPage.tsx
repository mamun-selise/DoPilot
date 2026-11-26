import { useQueries } from "@tanstack/react-query";
import { ArrowRight, CloudUpload, ExternalLink, GitPullRequest, LayoutDashboard, Layers, RefreshCw, Server } from "lucide-react";
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { ActionButton } from "../../shared/ui/ActionButton";
import { EmptyState } from "../../shared/ui/EmptyState";
import { ErrorState } from "../../shared/ui/ErrorState";
import { PageHeader } from "../../shared/ui/PageHeader";
import { Skeleton } from "../../shared/ui/Skeleton";
import { StatusPill } from "../../shared/ui/StatusPill";
import { Checks, Mergeability, Review, TITLE_MATCH, fill, since } from "../pullRequests/PullRequestsPage";
import { reposOfKind } from "../pullRequests/RepoPicker";
import { usePullRequestHub, type PullRequest, type PullRequestRepo } from "../pullRequests/usePullRequests";
import { boardCardsQuery, type BoardColumn } from "../release/boardCards";
import { useRunners, type HubStatus, type Runner } from "../runners/useRunners";

const hubTone: Record<HubStatus, "good" | "warn" | "neutral"> = {
  online: "good",
  connecting: "neutral",
  reconnecting: "warn",
  offline: "warn",
  unconfigured: "neutral"
};

// Where the PRs and Deploy pages remember their repository (RepoPicker's REPO_KEY).
const REPO_KEY = { code: "blocks-app:prs-repo", deployment: "blocks-app:deploy-repo" };
// No update for this long and a PR counts as stale.
const STALE_DAYS = 7;
const LIST_LIMIT = 8;

type Entry = { repo: string; pr: PullRequest };

// Each PR in exactly one bucket, most pressing first, so the health bar adds up to the open count.
const BUCKETS = ["drafts", "conflicts", "failing", "changes", "ready", "review", "other"] as const;
type Bucket = (typeof BUCKETS)[number];
const BUCKET_LABEL: Record<Bucket, TranslationKey> = {
  drafts: "dashboard.metric.drafts",
  conflicts: "dashboard.metric.conflicts",
  failing: "dashboard.metric.failing",
  changes: "dashboard.metric.changes",
  ready: "dashboard.metric.ready",
  review: "dashboard.metric.review",
  other: "dashboard.metric.other"
};

function bucketOf(pr: PullRequest): Bucket {
  if (pr.isDraft) return "drafts";
  if (pr.mergeable === "CONFLICTING") return "conflicts";
  if (pr.checks.failed > 0) return "failing";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (pr.mergeState === "CLEAN" || pr.mergeState === "HAS_HOOKS") return "ready";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "review";
  return "other";
}

const isStale = (pr: PullRequest) => Date.now() - new Date(pr.updatedAt).getTime() > STALE_DAYS * 86_400_000;
// What needs someone to act: failing checks, conflicts, changes requested, or nothing happening for a week.
const needsAttention = (pr: PullRequest) => !pr.isDraft && (["conflicts", "failing", "changes"].includes(bucketOf(pr)) || isStale(pr));

// Moves to another page the way the sidebar does: the router follows popstate. A repo is preselected through the
// page's remembered selection.
function go(path: string, repo?: { kind: keyof typeof REPO_KEY; github: string }) {
  if (repo) localStorage.setItem(REPO_KEY[repo.kind], repo.github);
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Counts from the last shown value to the new one, so live updates tick over instead of jumping.
function useCountUp(value: number, duration = 900) {
  const [shown, setShown] = useState(reducedMotion() ? value : 0);
  useEffect(() => {
    if (reducedMotion()) return setShown(value);
    let frame = 0;
    const from = shown;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setShown(Math.round(from + (value - from) * eased));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return shown;
}

// False for the first frame, so bars and rings render at zero and then transition to their size.
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return mounted;
}

// Staggers the entrance of cards; the delay is read by the .dash-in animation.
const delay = (index: number): CSSProperties => ({ animationDelay: `${index * 70}ms` });

// The whole system at a glance: runners and their tasks, open pull requests, the Ready to stage board and the
// deployment PRs waiting for stage and prod. Shares the other pages' query caches, so moving between them does not
// ask GitHub again.
export function DashboardPage() {
  const { t } = useT();
  const runners = useRunners();
  const hub = usePullRequestHub();
  const codeRepos = reposOfKind(hub.repos, "code").filter((repo) => repo.runners.length > 0);
  const deployRepos = reposOfKind(hub.repos, "deployment").filter((repo) => repo.runners.length > 0);

  const prQuery = (repo: PullRequestRepo) => {
    const route = repo.runners[0]!; // repos without a runner are filtered out above
    return {
      queryKey: ["pull-requests", route.runnerId, repo.github],
      queryFn: async () => (await hub.askGitHub("ListPullRequests", route.runnerId, repo.github)).pullRequests ?? [],
      enabled: hub.status === "online",
      retry: false,
      staleTime: 30_000,
      refetchInterval: 60_000
    };
  };
  const codeQueries = useQueries({ queries: codeRepos.map(prQuery) });
  const deployQueries = useQueries({ queries: deployRepos.map(prQuery) });
  const boardQueries = useQueries({ queries: codeRepos.map((repo) => ({ ...boardCardsQuery(repo.github), retry: false })) });

  const code = codeRepos.map((repo, index) => ({ repo, query: codeQueries[index]! }));
  const all: Entry[] = code.flatMap(({ query, repo }) => (query.data ?? []).map((pr) => ({ repo: repo.github, pr })));
  const buckets = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])) as Record<Bucket, number>;
  for (const { pr } of all) buckets[bucketOf(pr)]++;
  const attention = all.filter((entry) => needsAttention(entry.pr)).sort((a, b) => a.pr.updatedAt.localeCompare(b.pr.updatedAt));

  const board = codeRepos.map((repo, index) => {
    const cards = boardQueries[index]?.data ?? [];
    const count = (column: BoardColumn) => cards.filter((card) => card.column === column).length;
    return { repo, ready: count("ready"), merged: count("merged"), deployed: count("deployed") };
  });
  const boardTotal = { ready: sum(board, "ready"), merged: sum(board, "merged"), deployed: sum(board, "deployed") };

  const deploys = deployRepos.map((repo, index) => {
    const prs = deployQueries[index]?.data ?? [];
    return {
      repo,
      loading: Boolean(deployQueries[index]?.isPending),
      stage: prs.filter((pr) => TITLE_MATCH.stage.test(pr.title)).length,
      prod: prs.filter((pr) => TITLE_MATCH.prod.test(pr.title)).length
    };
  });
  const busy = runners.runners.filter((runner) => runner.activeTasks > 0).length;
  const loadingPrs = codeQueries.some((query) => query.isPending);

  function refresh() {
    if (hub.status === "offline") hub.retry();
    if (runners.status === "offline") runners.retry();
    [...codeQueries, ...deployQueries, ...boardQueries].forEach((query) => void query.refetch());
  }

  return (
    <section className="wide dashboard">
      <PageHeader
        title={t("dashboard.title")}
        subtitle={t("dashboard.subtitle")}
        actions={
          <>
            <StatusPill tone={hubTone[hub.status]}>{t(`runners.hub.${hub.status}`)}</StatusPill>
            <ActionButton variant="icon" onClick={refresh} title={t("common.refresh")} icon={<RefreshCw size={18} />} />
          </>
        }
      />

      {hub.status === "unconfigured" ? (
        <EmptyState icon={<LayoutDashboard size={22} />} title={t("runners.unconfigured.title")} description={t("runners.unconfigured.body")} />
      ) : hub.status === "offline" ? (
        <ErrorState message={hub.error || t("runners.offline")} onRetry={hub.retry} />
      ) : hub.status === "connecting" ? (
        <div className="dash-kpis">
          {[0, 1, 2, 3].map((index) => (
            <div className="panel" key={index}><Skeleton className="skeleton-line" /><Skeleton className="skeleton-line-lg" /></div>
          ))}
        </div>
      ) : (
        <>
          <div className="dash-kpis">
            <Kpi
              index={0}
              icon={<Server size={18} />}
              label={t("dashboard.kpi.runners")}
              value={runners.runners.length}
              sub={fill(t("dashboard.kpi.runnersSub"), { busy, idle: runners.runners.length - busy })}
              live={busy > 0}
              onClick={() => go("/runners")}
            />
            <Kpi
              index={1}
              icon={<GitPullRequest size={18} />}
              label={t("dashboard.kpi.prs")}
              value={all.length}
              sub={fill(t("dashboard.kpi.prsSub"), { ready: buckets.ready, attention: attention.length })}
              onClick={() => go("/prs")}
            />
            <Kpi
              index={2}
              icon={<Layers size={18} />}
              label={t("dashboard.kpi.release")}
              value={boardTotal.ready + boardTotal.merged}
              sub={fill(t("dashboard.kpi.releaseSub"), boardTotal)}
              onClick={() => go("/release/stage")}
            />
            <Kpi
              index={3}
              icon={<CloudUpload size={18} />}
              label={t("dashboard.kpi.deploys")}
              value={sum(deploys, "stage") + sum(deploys, "prod")}
              sub={fill(t("dashboard.kpi.deploysSub"), { stage: sum(deploys, "stage"), prod: sum(deploys, "prod") })}
              onClick={() => go("/release/deploy-stage")}
            />
          </div>

          <div className="dash-grid">
            <Card index={4} title={t("dashboard.health")} icon={<GitPullRequest size={16} />}>
              {loadingPrs && all.length === 0 ? (
                <Skeleton className="skeleton-line" />
              ) : all.length === 0 ? (
                <span className="muted">{t("prs.empty.title")}</span>
              ) : (
                <HealthBar buckets={buckets} total={all.length} />
              )}
            </Card>

            <RunnersCard index={5} runners={runners.runners} status={runners.status} error={runners.error} onRetry={runners.retry} />

            <Card index={6} title={t("dashboard.repos")} icon={<GitPullRequest size={16} />}>
              {code.length === 0 ? (
                <span className="muted">{t("prs.noRepos.title")}</span>
              ) : (
                <RepoBars
                  rows={code.map(({ query, repo }) => ({
                    key: repo.github,
                    label: repo.github,
                    value: query.data?.length ?? 0,
                    loading: query.isPending,
                    error: query.isError ? query.error?.message : undefined,
                    onClick: () => go("/prs", { kind: "code", github: repo.github })
                  }))}
                />
              )}
            </Card>

            <Card index={7} title={t("dashboard.pipeline")} icon={<Layers size={16} />}>
              <Pipeline totals={boardTotal} />
              {board.some((row) => row.ready + row.merged + row.deployed > 0) ? (
                <div className="dash-pipeline-repos">
                  {board
                    .filter((row) => row.ready + row.merged + row.deployed > 0)
                    .map((row) => (
                      <button key={row.repo.github} className="dash-row-link" onClick={() => go("/release/stage", { kind: "code", github: row.repo.github })}>
                        <span className="truncate">{row.repo.github}</span>
                        <span className="muted">{row.ready} · {row.merged} · {row.deployed}</span>
                      </button>
                    ))}
                </div>
              ) : (
                <span className="muted">{t("dashboard.pipeline.empty")}</span>
              )}
            </Card>

            <Card index={8} title={t("dashboard.deploys")} icon={<CloudUpload size={16} />}>
              {deploys.length === 0 ? (
                <span className="muted">{t("dashboard.deploys.empty")}</span>
              ) : (
                <div className="dash-deploys">
                  {deploys.map((row) => (
                    <div className="dash-deploy" key={row.repo.github}>
                      <span className="truncate">{row.repo.github}</span>
                      {row.loading ? (
                        <Skeleton className="skeleton-line" />
                      ) : (
                        <div className="dash-deploy-targets">
                          <button className="dash-chip" onClick={() => go("/release/deploy-stage", { kind: "deployment", github: row.repo.github })}>
                            {t("dashboard.deploys.stage")} <Counter value={row.stage} />
                          </button>
                          <button className="dash-chip" onClick={() => go("/release/deploy-prod", { kind: "deployment", github: row.repo.github })}>
                            {t("dashboard.deploys.prod")} <Counter value={row.prod} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <h3 className="dashboard-heading dash-in" style={delay(9)}>
            {t("dashboard.attention")} {attention.length ? <span className="muted">({attention.length})</span> : null}
          </h3>
          {attention.length === 0 ? (
            <div className="panel dash-in" style={delay(10)}>
              {loadingPrs ? <Skeleton className="skeleton-line" /> : <span className="muted">{t("dashboard.attention.empty")}</span>}
            </div>
          ) : (
            <div className="table-shell dash-in" style={delay(10)}>
              <table className="runners-table prs-table">
                <thead>
                  <tr>
                    <th>{t("prs.col.pr")}</th>
                    <th>{t("prs.col.author")}</th>
                    <th>{t("prs.col.checks")}</th>
                    <th>{t("prs.col.review")}</th>
                    <th>{t("prs.col.merge")}</th>
                    <th>{t("prs.col.updated")}</th>
                  </tr>
                </thead>
                <tbody>
                  {attention.slice(0, LIST_LIMIT).map(({ pr, repo }, index) => (
                    <tr key={`${repo}#${pr.number}`} className="dash-in" style={delay(11 + index)}>
                      <td>
                        <div className="runner-stack">
                          <a className="pr-title" href={pr.url} target="_blank" rel="noreferrer">
                            <span className="muted">#{pr.number}</span> {pr.title} <ExternalLink size={12} />
                          </a>
                          <span className="muted mono-sm">{repo}</span>
                        </div>
                      </td>
                      <td>{pr.author ?? "—"}</td>
                      <td><Checks checks={pr.checks} /></td>
                      <td><Review decision={pr.reviewDecision} /></td>
                      <td><Mergeability pr={pr} /></td>
                      <td title={new Date(pr.updatedAt).toLocaleString()}>{since(pr.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {attention.length > LIST_LIMIT ? <p className="muted prs-identity">{fill(t("dashboard.more"), { count: attention.length - LIST_LIMIT })}</p> : null}
        </>
      )}
    </section>
  );
}

function sum<T, K extends keyof T>(rows: T[], key: K) {
  return rows.reduce((total, row) => total + (row[key] as number), 0);
}

function Counter({ value }: { value: number }) {
  return <strong className="dash-number">{useCountUp(value)}</strong>;
}

function Kpi({ icon, index, label, live, onClick, sub, value }: { icon: ReactNode; index: number; label: string; live?: boolean; onClick: () => void; sub: string; value: number }) {
  return (
    <button className="panel dash-kpi dash-in" style={delay(index)} onClick={onClick}>
      <span className="dash-kpi-label">
        <span className="dash-kpi-icon">{icon}</span>
        {label}
        {live ? <span className="dash-live" aria-hidden /> : null}
      </span>
      <strong className="dash-kpi-value">{useCountUp(value)}</strong>
      <span className="muted dash-kpi-sub">{sub}</span>
      <ArrowRight size={16} className="dash-kpi-arrow" />
    </button>
  );
}

function Card({ children, icon, index, title }: { children: ReactNode; icon: ReactNode; index: number; title: string }) {
  return (
    <div className="panel dash-card dash-in" style={delay(index)}>
      <div className="panel-title">{icon}<span>{title}</span></div>
      {children}
    </div>
  );
}

function HealthBar({ buckets, total }: { buckets: Record<Bucket, number>; total: number }) {
  const { t } = useT();
  const mounted = useMounted();
  const shown = BUCKETS.filter((bucket) => buckets[bucket] > 0);
  return (
    <>
      <div className="dash-stack" role="img" aria-label={shown.map((bucket) => `${t(BUCKET_LABEL[bucket])}: ${buckets[bucket]}`).join(", ")}>
        {shown.map((bucket) => (
          <span
            key={bucket}
            className={`dash-seg dash-${bucket}`}
            style={{ width: mounted ? `${(buckets[bucket] / total) * 100}%` : 0 }}
            title={`${t(BUCKET_LABEL[bucket])}: ${buckets[bucket]}`}
          />
        ))}
      </div>
      <div className="dash-legend">
        {shown.map((bucket) => (
          <span key={bucket}>
            <i className={`dash-dot dash-${bucket}`} />
            {t(BUCKET_LABEL[bucket])} <Counter value={buckets[bucket]} />
          </span>
        ))}
      </div>
    </>
  );
}

type Bar = { key: string; label: string; value: number; loading: boolean; error?: string; onClick: () => void };

function RepoBars({ rows }: { rows: Bar[] }) {
  const { t } = useT();
  const mounted = useMounted();
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <div className="dash-bars">
      {[...rows].sort((a, b) => b.value - a.value).map((row) => (
        <button key={row.key} className="dash-bar-row" onClick={row.onClick} title={row.error}>
          <span className="truncate">{row.label}</span>
          {row.error ? (
            <StatusPill tone="warn">{t("dashboard.repoError")}</StatusPill>
          ) : row.loading ? (
            <Skeleton className="skeleton-line" />
          ) : (
            <span className="dash-bar-track">
              <span className="dash-bar" style={{ width: mounted ? `${(row.value / max) * 100}%` : 0 }} />
            </span>
          )}
          <Counter value={row.value} />
        </button>
      ))}
    </div>
  );
}

function Pipeline({ totals }: { totals: Record<BoardColumn, number> }) {
  const { t } = useT();
  const stages: [TranslationKey, number][] = [
    ["dashboard.pipeline.ready", totals.ready],
    ["dashboard.pipeline.merged", totals.merged],
    ["dashboard.pipeline.deployed", totals.deployed]
  ];
  return (
    <div className="dash-pipeline">
      {stages.map(([label, value], index) => (
        <div className="dash-stage" key={label}>
          {index > 0 ? <span className="dash-flow" aria-hidden /> : null}
          <Counter value={value} />
          <span className="muted">{t(label)}</span>
        </div>
      ))}
    </div>
  );
}

function RunnersCard({ error, index, onRetry, runners, status }: { error?: string; index: number; onRetry: () => void; runners: Runner[]; status: HubStatus }) {
  const { t } = useT();
  const mounted = useMounted();
  const done = runners.reduce((total, runner) => total + runner.completedTasks, 0);
  const failed = runners.reduce((total, runner) => total + runner.failedTasks, 0);
  const rate = done + failed ? done / (done + failed) : 0;
  const tasks = runners.flatMap((runner) => runner.currentTasks.map((task) => ({ task, runner })));
  const circumference = 2 * Math.PI * 34;
  const percent = useCountUp(Math.round(rate * 100));

  return (
    <Card index={index} title={t("dashboard.runners")} icon={<Server size={16} />}>
      {status === "offline" ? (
        <ErrorState message={error || t("runners.offline")} onRetry={onRetry} />
      ) : status === "connecting" ? (
        <Skeleton className="skeleton-line" />
      ) : (
        <div className="dash-runners">
          <div className="dash-ring" title={t("dashboard.runners.success")}>
            <svg viewBox="0 0 80 80" aria-hidden>
              <circle cx="40" cy="40" r="34" className="dash-ring-track" />
              <circle
                cx="40"
                cy="40"
                r="34"
                className="dash-ring-value"
                strokeDasharray={circumference}
                strokeDashoffset={mounted ? circumference * (1 - rate) : circumference}
              />
            </svg>
            <span className="dash-ring-label">
              <strong className="dash-number">{percent}%</strong>
              <small className="muted">{t("dashboard.runners.success")}</small>
            </span>
          </div>
          <div className="dash-runner-tasks">
            <span className="muted">{fill(t("dashboard.runners.tasks"), { done, failed })}</span>
            <strong className="dash-subheading">{t("dashboard.runners.running")}</strong>
            {tasks.length === 0 ? (
              <span className="muted">{t("dashboard.runners.noneRunning")}</span>
            ) : (
              tasks.slice(0, 4).map(({ runner, task }) => (
                <div className="dash-task" key={task.id} title={task.prompt}>
                  <span className={task.state === "Running" ? "dash-live" : "dash-queued"} aria-hidden />
                  <span className="truncate"><strong>{task.repo}</strong> · {task.prompt}</span>
                  <small className="muted">{runner.name}{task.state === "Queued" ? ` · ${t("runners.task.queued")}` : ""}</small>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
