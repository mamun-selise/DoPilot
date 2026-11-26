import { useQueries } from "@tanstack/react-query";
import { ExternalLink, LayoutDashboard, RefreshCw } from "lucide-react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { ActionButton } from "../../shared/ui/ActionButton";
import { EmptyState } from "../../shared/ui/EmptyState";
import { ErrorState } from "../../shared/ui/ErrorState";
import { PageHeader } from "../../shared/ui/PageHeader";
import { Skeleton } from "../../shared/ui/Skeleton";
import { StatusPill } from "../../shared/ui/StatusPill";
import type { HubStatus } from "../runners/useRunners";
import { Checks, Mergeability, Review, fill, since } from "./PullRequestsPage";
import { reposOfKind } from "./RepoPicker";
import { usePullRequestHub, type PullRequest } from "./usePullRequests";

const hubTone: Record<HubStatus, "good" | "warn" | "neutral"> = {
  online: "good",
  connecting: "neutral",
  reconnecting: "warn",
  offline: "warn",
  unconfigured: "neutral"
};

// The PRs page remembers its repository here (RepoPicker's REPO_KEY for code repositories).
const PRS_REPO_KEY = "blocks-app:prs-repo";
// No update for this long and a PR counts as stale.
const STALE_DAYS = 7;
const LIST_LIMIT = 10;

type Entry = { repo: string; pr: PullRequest };

const isReady = (pr: PullRequest) => !pr.isDraft && pr.mergeable !== "CONFLICTING" && (pr.mergeState === "CLEAN" || pr.mergeState === "HAS_HOOKS");
const isStale = (pr: PullRequest) => Date.now() - new Date(pr.updatedAt).getTime() > STALE_DAYS * 86_400_000;
// What needs someone to act: failing checks, conflicts, changes requested, or nothing happening for a week.
const needsAttention = (pr: PullRequest) =>
  !pr.isDraft && (pr.checks.failed > 0 || pr.mergeable === "CONFLICTING" || pr.reviewDecision === "CHANGES_REQUESTED" || isStale(pr));

function counts(prs: PullRequest[]) {
  return {
    open: prs.length,
    ready: prs.filter(isReady).length,
    review: prs.filter((pr) => !pr.isDraft && pr.reviewDecision === "REVIEW_REQUIRED").length,
    changes: prs.filter((pr) => pr.reviewDecision === "CHANGES_REQUESTED").length,
    failing: prs.filter((pr) => pr.checks.failed > 0).length,
    conflicts: prs.filter((pr) => pr.mergeable === "CONFLICTING").length,
    drafts: prs.filter((pr) => pr.isDraft).length,
    stale: prs.filter(isStale).length
  };
}

// Opens the PRs page on a repository: the page reads its selection from storage, and the router follows popstate.
function openRepo(repo: string) {
  localStorage.setItem(PRS_REPO_KEY, repo);
  window.history.pushState({}, "", "/prs");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// Open pull requests across every code repository the user's runners reach, each asked of its first runner. Shares
// the PRs page's query cache, so switching between the two does not ask GitHub again.
export function PullRequestsDashboardPage() {
  const { t } = useT();
  const hub = usePullRequestHub();
  const repos = reposOfKind(hub.repos, "code").filter((repo) => repo.runners.length > 0);

  const queries = useQueries({
    queries: repos.map((repo) => {
      const route = repo.runners[0]!; // repos without a runner are filtered out above
      return {
        queryKey: ["pull-requests", route.runnerId, repo.github],
        queryFn: async () => (await hub.askGitHub("ListPullRequests", route.runnerId, repo.github)).pullRequests ?? [],
        enabled: hub.status === "online",
        retry: false,
        staleTime: 30_000,
        refetchInterval: 60_000
      };
    })
  });

  const rows = repos.map((repo, index) => ({ repo, query: queries[index]! }));
  const all: Entry[] = rows.flatMap(({ query, repo }) => (query.data ?? []).map((pr) => ({ repo: repo.github, pr })));
  const totals = counts(all.map((entry) => entry.pr));
  const loading = queries.some((query) => query.isPending);
  const byAge = (a: Entry, b: Entry) => new Date(a.pr.updatedAt).getTime() - new Date(b.pr.updatedAt).getTime();
  const attention = all.filter((entry) => needsAttention(entry.pr)).sort(byAge);
  const ready = all.filter((entry) => isReady(entry.pr)).sort(byAge);

  const metrics: [TranslationKey, number][] = [
    ["dashboard.metric.open", totals.open],
    ["dashboard.metric.ready", totals.ready],
    ["dashboard.metric.review", totals.review],
    ["dashboard.metric.changes", totals.changes],
    ["dashboard.metric.failing", totals.failing],
    ["dashboard.metric.conflicts", totals.conflicts],
    ["dashboard.metric.drafts", totals.drafts],
    ["dashboard.metric.stale", totals.stale]
  ];

  return (
    <section className="wide">
      <PageHeader
        title={t("dashboard.title")}
        subtitle={t("dashboard.subtitle")}
        actions={
          <>
            <StatusPill tone={hubTone[hub.status]}>{t(`runners.hub.${hub.status}`)}</StatusPill>
            <ActionButton
              variant="icon"
              onClick={() => (hub.status === "offline" ? hub.retry() : queries.forEach((query) => void query.refetch()))}
              title={t("common.refresh")}
              icon={<RefreshCw size={18} />}
            />
          </>
        }
      />

      {hub.status === "unconfigured" ? (
        <EmptyState icon={<LayoutDashboard size={22} />} title={t("runners.unconfigured.title")} description={t("runners.unconfigured.body")} />
      ) : hub.status === "offline" ? (
        <ErrorState message={hub.error || t("runners.offline")} onRetry={hub.retry} />
      ) : hub.status === "connecting" ? (
        <div className="panel">
          <Skeleton className="skeleton-line" />
          <Skeleton className="skeleton-line" />
        </div>
      ) : repos.length === 0 ? (
        <EmptyState icon={<LayoutDashboard size={22} />} title={t("prs.noRepos.title")} description={t("prs.noRepos.body")} />
      ) : (
        <>
          <div className="runners-summary">
            {metrics.map(([label, value]) => (
              <div className="panel" key={label}>
                <span className="muted">{t(label)}</span>
                <strong>{loading && all.length === 0 ? "…" : value}</strong>
              </div>
            ))}
          </div>

          <h3 className="dashboard-heading">{t("dashboard.repos")}</h3>
          <div className="table-shell">
            <table className="runners-table prs-table">
              <thead>
                <tr>
                  <th>{t("prs.repository")}</th>
                  <th>{t("dashboard.metric.open")}</th>
                  <th>{t("dashboard.metric.ready")}</th>
                  <th>{t("dashboard.metric.review")}</th>
                  <th>{t("dashboard.metric.failing")}</th>
                  <th>{t("dashboard.metric.conflicts")}</th>
                  <th>{t("dashboard.oldest")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ query, repo }) => {
                  const prs = query.data ?? [];
                  const repoCounts = counts(prs);
                  const oldest = prs.reduce<string | undefined>((min, pr) => (!min || pr.createdAt < min ? pr.createdAt : min), undefined);
                  return (
                    <tr key={repo.github}>
                      <td>
                        <a className="pr-title" href="/prs" onClick={(event) => { event.preventDefault(); openRepo(repo.github); }}>
                          {repo.github}
                        </a>
                      </td>
                      {query.isError ? (
                        <td colSpan={6} title={query.error?.message}><StatusPill tone="warn">{t("dashboard.repoError")}</StatusPill></td>
                      ) : query.isPending ? (
                        <td colSpan={6}><Skeleton className="skeleton-line" /></td>
                      ) : (
                        <>
                          <td><strong>{repoCounts.open}</strong></td>
                          <td>{repoCounts.ready}</td>
                          <td>{repoCounts.review}</td>
                          <td>{repoCounts.failing}</td>
                          <td>{repoCounts.conflicts}</td>
                          <td>{oldest ? <span title={new Date(oldest).toLocaleString()}>{since(oldest)}</span> : <span className="muted">—</span>}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <PullRequestList title={t("dashboard.attention")} empty={t("dashboard.attention.empty")} entries={attention} loading={loading} />
          <PullRequestList title={t("dashboard.readyList")} empty={t("dashboard.readyList.empty")} entries={ready} loading={loading} />
        </>
      )}
    </section>
  );
}

function PullRequestList({ empty, entries, loading, title }: { empty: string; entries: Entry[]; loading: boolean; title: string }) {
  const { t } = useT();
  const shown = entries.slice(0, LIST_LIMIT);

  return (
    <>
      <h3 className="dashboard-heading">
        {title} {entries.length ? <span className="muted">({entries.length})</span> : null}
      </h3>
      {entries.length === 0 ? (
        <div className="panel">{loading ? <Skeleton className="skeleton-line" /> : <span className="muted">{empty}</span>}</div>
      ) : (
        <div className="table-shell">
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
              {shown.map(({ pr, repo }) => (
                <tr key={`${repo}#${pr.number}`}>
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
      {entries.length > shown.length ? <p className="muted prs-identity">{fill(t("dashboard.more"), { count: entries.length - shown.length })}</p> : null}
    </>
  );
}
