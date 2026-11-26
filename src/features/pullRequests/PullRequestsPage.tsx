import { Check, ExternalLink, GitMerge, GitPullRequest, RefreshCw, Rocket, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { ActionButton } from "../../shared/ui/ActionButton";
import { Alert } from "../../shared/ui/Alert";
import { EmptyState } from "../../shared/ui/EmptyState";
import { ErrorState } from "../../shared/ui/ErrorState";
import { Modal } from "../../shared/ui/Modal";
import { PageHeader } from "../../shared/ui/PageHeader";
import { Skeleton } from "../../shared/ui/Skeleton";
import { StatusPill } from "../../shared/ui/StatusPill";
import type { HubStatus } from "../runners/useRunners";
import { AddRepositoryButton, RepoPicker, useRepoSelection } from "./RepoPicker";
import {
  useApprovePullRequest,
  useMergePullRequest,
  useOpenPullRequests,
  usePullRequestHub,
  type MergeMethod,
  type PullRequest,
  type PullRequestRoute
} from "./usePullRequests";

const hubTone: Record<HubStatus, "good" | "warn" | "neutral"> = {
  online: "good",
  connecting: "neutral",
  reconnecting: "warn",
  offline: "warn",
  unconfigured: "neutral"
};

// Merge commit and keep the branch unless chosen otherwise; a new key so an old "squash" choice is not picked up.
const MERGE_METHOD_KEY = "blocks-app:merge-method";

// "code": the PRs page, code repositories, every open PR. "stage" / "prod": the Release > Deploy pages, deployment
// (yml) repositories only, and only the PRs whose title names that environment (they all target the same branch).
export type PullRequestsVariant = "code" | "stage" | "prod";

const TITLE_MATCH: Record<Exclude<PullRequestsVariant, "code">, RegExp> = {
  stage: /\bstag(e|ing)\b/i,
  prod: /\bprod(uction)?\b/i
};

const TEXT: Record<PullRequestsVariant, { title: TranslationKey; subtitle: TranslationKey; empty: TranslationKey; emptyBody: TranslationKey; noRepos: TranslationKey; noReposBody: TranslationKey }> = {
  code: { title: "prs.title", subtitle: "prs.subtitle", empty: "prs.empty.title", emptyBody: "prs.empty.body", noRepos: "prs.noRepos.title", noReposBody: "prs.noRepos.body" },
  stage: { title: "deploy.stage.title", subtitle: "deploy.stage.subtitle", empty: "deploy.stage.empty", emptyBody: "deploy.stage.emptyBody", noRepos: "deploy.noRepos.title", noReposBody: "deploy.noRepos.body" },
  prod: { title: "deploy.prod.title", subtitle: "deploy.prod.subtitle", empty: "deploy.prod.empty", emptyBody: "deploy.prod.emptyBody", noRepos: "deploy.noRepos.title", noReposBody: "deploy.noRepos.body" }
};

export function PullRequestsPage() {
  return <PullRequestsView variant="code" />;
}

// top: shown under the repository picker (Quick deploy on the Deploy pages).
export function PullRequestsView({ top, variant }: { top?: (context: { hub: ReturnType<typeof usePullRequestHub>; repo: string; route: PullRequestRoute }) => ReactNode; variant: PullRequestsVariant }) {
  const { t } = useT();
  const hub = usePullRequestHub();
  const selection = useRepoSelection(hub.repos, variant === "code" ? "code" : "deployment");
  const { route, selected } = selection;
  const [approving, setApproving] = useState<PullRequest | null>(null);
  const [merging, setMerging] = useState<PullRequest | null>(null);
  const text = TEXT[variant];
  const Icon = variant === "code" ? GitPullRequest : Rocket;

  const query = useOpenPullRequests(hub.askGitHub, route, selected?.github, hub.status === "online");
  const shown = useMemo(
    () => (variant === "code" ? query.data : query.data?.filter((pr) => TITLE_MATCH[variant].test(pr.title))),
    [query.data, variant]
  );
  const [search, setSearch] = useState("");
  const found = useMemo(() => (shown ? shown.filter((pr) => matches(pr, search)) : shown), [shown, search]);
  const prs = { ...query, data: found };

  return (
    <section className="wide">
      <PageHeader
        title={t(text.title)}
        subtitle={t(text.subtitle)}
        actions={
          <>
            <StatusPill tone={hubTone[hub.status]}>{t(`runners.hub.${hub.status}`)}</StatusPill>
            <ActionButton
              variant="icon"
              onClick={() => (hub.status === "offline" ? hub.retry() : void prs.refetch())}
              title={t("common.refresh")}
              icon={<RefreshCw size={18} />}
            />
          </>
        }
      />

      {hub.status === "unconfigured" ? (
        <EmptyState icon={<Icon size={22} />} title={t("runners.unconfigured.title")} description={t("runners.unconfigured.body")} />
      ) : hub.status === "offline" ? (
        <ErrorState message={hub.error || t("runners.offline")} onRetry={hub.retry} />
      ) : hub.status === "connecting" ? (
        <div className="panel">
          <Skeleton className="skeleton-line" />
          <Skeleton className="skeleton-line" />
        </div>
      ) : !selected || !route ? (
        <EmptyState
          icon={<Icon size={22} />}
          title={t(text.noRepos)}
          description={t(text.noReposBody)}
          action={<AddRepositoryButton hub={hub} onAdded={selection.selectRepo} deployment={variant !== "code"} />}
        />
      ) : (
        <>
          <RepoPicker hub={hub} {...selection} selected={selected} route={route} />
          {top?.({ hub, repo: selected.github, route })}

          {shown && shown.length > 0 ? (
            <div className="toolbar">
              <label className="search-box">
                <Search size={16} className="muted" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("prs.search.placeholder")}
                  aria-label={t("prs.search.placeholder")}
                />
                {search ? (
                  <button className="icon-button search-clear" onClick={() => setSearch("")} aria-label={t("prs.search.clear")}>
                    <X size={14} />
                  </button>
                ) : null}
              </label>
              <span className="muted">{search ? fill(t("prs.search.count"), { shown: found?.length ?? 0, total: shown.length }) : fill(t("prs.search.total"), { total: shown.length })}</span>
            </div>
          ) : null}

          {prs.isError ? (
            <ErrorState message={prs.error.message} onRetry={() => void prs.refetch()} />
          ) : prs.isPending || !prs.data ? (
            <div className="panel">
              <Skeleton className="skeleton-line" />
              <Skeleton className="skeleton-line" />
              <Skeleton className="skeleton-line" />
            </div>
          ) : prs.data.length === 0 && search ? (
            <EmptyState
              icon={<Search size={22} />}
              title={t("prs.search.none")}
              description={fill(t("prs.search.noneBody"), { search })}
              action={<button className="icon-button" onClick={() => setSearch("")}>{t("prs.search.clear")}</button>}
            />
          ) : prs.data.length === 0 ? (
            <EmptyState icon={<Icon size={22} />} title={t(text.empty)} description={fill(t(text.emptyBody), { repo: selected.github })} />
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
                    <th>{t("prs.col.changes")}</th>
                    <th>{t("prs.col.updated")}</th>
                    <th aria-label={t("prs.col.actions")} />
                  </tr>
                </thead>
                <tbody>
                  {prs.data.map((pr) => {
                    const own = Boolean(pr.author && route.githubAccount && pr.author.toLowerCase() === route.githubAccount.toLowerCase());
                    const conflicting = pr.mergeable === "CONFLICTING";
                    return (
                      <tr key={pr.number}>
                        <td>
                          <div className="runner-stack">
                            <a className="pr-title" href={pr.url} target="_blank" rel="noreferrer">
                              <span className="muted">#{pr.number}</span> {pr.title} <ExternalLink size={12} />
                            </a>
                            <span className="muted mono-sm">{pr.head} → {pr.base}</span>
                            {pr.isDraft || pr.labels.length ? (
                              <div className="chips">
                                {pr.isDraft ? <span className="chip">{t("prs.draft")}</span> : null}
                                {pr.labels.map((label) => <span className="chip" key={label}>{label}</span>)}
                              </div>
                            ) : null}
                          </div>
                        </td>
                        <td>{pr.author ?? "—"}</td>
                        <td><Checks checks={pr.checks} /></td>
                        <td><Review decision={pr.reviewDecision} /></td>
                        <td><Mergeability pr={pr} /></td>
                        <td>
                          <span className="pr-add">+{pr.additions}</span> <span className="pr-del">−{pr.deletions}</span>
                          <div className="muted">{fill(t("prs.files"), { count: pr.changedFiles })}</div>
                        </td>
                        <td title={new Date(pr.updatedAt).toLocaleString()}>{since(pr.updatedAt)}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              className="icon-button"
                              onClick={() => setApproving(pr)}
                              disabled={own}
                              title={own ? t("prs.approve.own") : t("prs.approve")}
                            >
                              <Check size={16} /> {t("prs.approve")}
                            </button>
                            <button
                              className="primary-button"
                              onClick={() => setMerging(pr)}
                              disabled={pr.isDraft || conflicting}
                              title={pr.isDraft ? t("prs.merge.draft") : conflicting ? t("prs.merge.conflicts") : t("prs.merge")}
                            >
                              <GitMerge size={16} /> {t("prs.merge")}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted prs-identity">{fill(t("prs.identity"), { account: route.githubAccount ?? "?", runner: route.runnerName })}</p>
        </>
      )}

      {approving && route && selected ? (
        <ApproveDialog askGitHub={hub.askGitHub} pr={approving} repo={selected.github} route={route} onClose={() => setApproving(null)} />
      ) : null}
      {merging && route && selected ? (
        <MergeDialog askGitHub={hub.askGitHub} pr={merging} repo={selected.github} route={route} onClose={() => setMerging(null)} />
      ) : null}
    </section>
  );
}

type DialogProps = {
  askGitHub: ReturnType<typeof usePullRequestHub>["askGitHub"];
  pr: PullRequest;
  repo: string;
  route: PullRequestRoute;
  onClose: () => void;
};

function ApproveDialog({ askGitHub, onClose, pr, repo, route }: DialogProps) {
  const { t } = useT();
  const approve = useApprovePullRequest(askGitHub);
  const [body, setBody] = useState("");

  return (
    <Modal title={fill(t("prs.approve.title"), { number: pr.number })} onClose={onClose}>
      <p>{pr.title}</p>
      <label className="form-field">
        <span>{t("prs.approve.comment")}</span>
        <textarea rows={3} value={body} onChange={(event) => setBody(event.target.value)} placeholder={t("prs.approve.placeholder")} />
      </label>
      <p className="muted">{fill(t("prs.identity"), { account: route.githubAccount ?? "?", runner: route.runnerName })}</p>
      {approve.isError ? <Alert tone="error">{approve.error.message}</Alert> : null}
      <div className="modal-actions">
        <button className="icon-button" onClick={onClose}>{t("common.cancel")}</button>
        <button
          className="primary-button"
          disabled={approve.isPending}
          onClick={() => approve.mutate({ route, repo, number: pr.number, body }, { onSuccess: onClose })}
        >
          <Check size={16} /> {approve.isPending ? t("prs.working") : t("prs.approve")}
        </button>
      </div>
    </Modal>
  );
}

function MergeDialog({ askGitHub, onClose, pr, repo, route }: DialogProps) {
  const { t } = useT();
  const merge = useMergePullRequest(askGitHub);
  const [method, setMethod] = useState<MergeMethod>(() => (localStorage.getItem(MERGE_METHOD_KEY) as MergeMethod | null) ?? "merge");
  const [deleteBranch, setDeleteBranch] = useState(false);

  function confirm() {
    localStorage.setItem(MERGE_METHOD_KEY, method);
    merge.mutate({ route, repo, number: pr.number, method, deleteBranch }, { onSuccess: onClose });
  }

  return (
    <Modal title={fill(t("prs.merge.title"), { number: pr.number })} onClose={onClose}>
      <p>{pr.title}</p>
      <p className="muted mono-sm">{pr.head} → {pr.base}</p>
      {pr.reviewDecision !== "APPROVED" || pr.checks.failed > 0 || pr.checks.pending > 0 ? (
        <Alert tone="warn">{t("prs.merge.notReady")}</Alert>
      ) : null}
      <label className="form-field">
        <span>{t("prs.merge.method")}</span>
        <select value={method} onChange={(event) => setMethod(event.target.value as MergeMethod)}>
          <option value="merge">{t("prs.merge.commit")}</option>
          <option value="squash">{t("prs.merge.squash")}</option>
          <option value="rebase">{t("prs.merge.rebase")}</option>
        </select>
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} />
        <span>{fill(t("prs.merge.deleteBranch"), { branch: pr.head })}</span>
      </label>
      <p className="muted">{fill(t("prs.identity"), { account: route.githubAccount ?? "?", runner: route.runnerName })}</p>
      {merge.isError ? <Alert tone="error">{merge.error.message}</Alert> : null}
      <div className="modal-actions">
        <button className="icon-button" onClick={onClose}>{t("common.cancel")}</button>
        <button className="primary-button" disabled={merge.isPending} onClick={confirm}>
          <GitMerge size={16} /> {merge.isPending ? t("prs.working") : t("prs.merge")}
        </button>
      </div>
    </Modal>
  );
}

export function Checks({ checks }: { checks: PullRequest["checks"] }) {
  const { t } = useT();
  if (checks.failed) return <StatusPill tone="warn">{fill(t("prs.checks.failed"), { count: checks.failed })}</StatusPill>;
  if (checks.pending) return <StatusPill tone="neutral">{fill(t("prs.checks.pending"), { count: checks.pending })}</StatusPill>;
  if (checks.passed) return <StatusPill tone="good">{t("prs.checks.passed")}</StatusPill>;
  return <span className="muted">{t("prs.checks.none")}</span>;
}

export function Review({ decision }: { decision: PullRequest["reviewDecision"] }) {
  const { t } = useT();
  if (decision === "APPROVED") return <StatusPill tone="good">{t("prs.review.approved")}</StatusPill>;
  if (decision === "CHANGES_REQUESTED") return <StatusPill tone="warn">{t("prs.review.changes")}</StatusPill>;
  if (decision === "REVIEW_REQUIRED") return <StatusPill tone="neutral">{t("prs.review.required")}</StatusPill>;
  return <span className="muted">—</span>;
}

export function Mergeability({ pr }: { pr: PullRequest }) {
  const { t } = useT();
  if (pr.isDraft) return <StatusPill tone="neutral">{t("prs.draft")}</StatusPill>;
  if (pr.mergeable === "CONFLICTING") return <StatusPill tone="warn">{t("prs.state.conflicts")}</StatusPill>;
  if (pr.mergeState === "CLEAN" || pr.mergeState === "HAS_HOOKS") return <StatusPill tone="good">{t("prs.state.ready")}</StatusPill>;
  if (pr.mergeState === "BLOCKED") return <StatusPill tone="warn">{t("prs.state.blocked")}</StatusPill>;
  if (pr.mergeState === "BEHIND") return <StatusPill tone="warn">{t("prs.state.behind")}</StatusPill>;
  if (pr.mergeState === "UNSTABLE") return <StatusPill tone="warn">{t("prs.state.unstable")}</StatusPill>;
  return <span className="muted">{t("prs.state.unknown")}</span>;
}

// Every word must appear in the PR's number, title, author, branches or labels ("#12", "12", "fix login", "dependabot").
function matches(pr: PullRequest, search: string) {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [`#${pr.number}`, pr.title, pr.author ?? "", pr.head, pr.base, ...pr.labels, pr.isDraft ? "draft" : ""].join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// t() has no parameters, so translated strings carry {name} placeholders filled here.
export function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

export function since(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(iso).toLocaleDateString();
}
