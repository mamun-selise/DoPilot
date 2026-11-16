import { Check, ExternalLink, GitMerge, GitPullRequest, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { ActionButton } from "../../shared/ui/ActionButton";
import { Alert } from "../../shared/ui/Alert";
import { EmptyState } from "../../shared/ui/EmptyState";
import { ErrorState } from "../../shared/ui/ErrorState";
import { Modal } from "../../shared/ui/Modal";
import { PageHeader } from "../../shared/ui/PageHeader";
import { Skeleton } from "../../shared/ui/Skeleton";
import { StatusPill } from "../../shared/ui/StatusPill";
import type { HubStatus } from "../runners/useRunners";
import { RepoPicker, useRepoSelection } from "./RepoPicker";
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

const MERGE_METHOD_KEY = "blocks-app:prs-merge-method";

export function PullRequestsPage() {
  const { t } = useT();
  const hub = usePullRequestHub();
  const selection = useRepoSelection(hub.repos);
  const { route, selected } = selection;
  const [approving, setApproving] = useState<PullRequest | null>(null);
  const [merging, setMerging] = useState<PullRequest | null>(null);

  const prs = useOpenPullRequests(hub.askGitHub, route, selected?.github, hub.status === "online");

  return (
    <section className="wide">
      <PageHeader
        title={t("prs.title")}
        subtitle={t("prs.subtitle")}
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
        <EmptyState icon={<GitPullRequest size={22} />} title={t("runners.unconfigured.title")} description={t("runners.unconfigured.body")} />
      ) : hub.status === "offline" ? (
        <ErrorState message={hub.error || t("runners.offline")} onRetry={hub.retry} />
      ) : hub.status === "connecting" ? (
        <div className="panel">
          <Skeleton className="skeleton-line" />
          <Skeleton className="skeleton-line" />
        </div>
      ) : !selected || !route ? (
        <EmptyState icon={<GitPullRequest size={22} />} title={t("prs.noRepos.title")} description={t("prs.noRepos.body")} />
      ) : (
        <>
          <RepoPicker repos={hub.repos} {...selection} selected={selected} route={route} />

          {prs.isError ? (
            <ErrorState message={prs.error.message} onRetry={() => void prs.refetch()} />
          ) : prs.isPending ? (
            <div className="panel">
              <Skeleton className="skeleton-line" />
              <Skeleton className="skeleton-line" />
              <Skeleton className="skeleton-line" />
            </div>
          ) : prs.data.length === 0 ? (
            <EmptyState icon={<GitPullRequest size={22} />} title={t("prs.empty.title")} description={fill(t("prs.empty.body"), { repo: selected.github })} />
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
  const [method, setMethod] = useState<MergeMethod>(() => (localStorage.getItem(MERGE_METHOD_KEY) as MergeMethod | null) ?? "squash");
  const [deleteBranch, setDeleteBranch] = useState(true);

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
          <option value="squash">{t("prs.merge.squash")}</option>
          <option value="merge">{t("prs.merge.commit")}</option>
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

function Checks({ checks }: { checks: PullRequest["checks"] }) {
  const { t } = useT();
  if (checks.failed) return <StatusPill tone="warn">{fill(t("prs.checks.failed"), { count: checks.failed })}</StatusPill>;
  if (checks.pending) return <StatusPill tone="neutral">{fill(t("prs.checks.pending"), { count: checks.pending })}</StatusPill>;
  if (checks.passed) return <StatusPill tone="good">{t("prs.checks.passed")}</StatusPill>;
  return <span className="muted">{t("prs.checks.none")}</span>;
}

function Review({ decision }: { decision: PullRequest["reviewDecision"] }) {
  const { t } = useT();
  if (decision === "APPROVED") return <StatusPill tone="good">{t("prs.review.approved")}</StatusPill>;
  if (decision === "CHANGES_REQUESTED") return <StatusPill tone="warn">{t("prs.review.changes")}</StatusPill>;
  if (decision === "REVIEW_REQUIRED") return <StatusPill tone="neutral">{t("prs.review.required")}</StatusPill>;
  return <span className="muted">—</span>;
}

function Mergeability({ pr }: { pr: PullRequest }) {
  const { t } = useT();
  if (pr.isDraft) return <StatusPill tone="neutral">{t("prs.draft")}</StatusPill>;
  if (pr.mergeable === "CONFLICTING") return <StatusPill tone="warn">{t("prs.state.conflicts")}</StatusPill>;
  if (pr.mergeState === "CLEAN" || pr.mergeState === "HAS_HOOKS") return <StatusPill tone="good">{t("prs.state.ready")}</StatusPill>;
  if (pr.mergeState === "BLOCKED") return <StatusPill tone="warn">{t("prs.state.blocked")}</StatusPill>;
  if (pr.mergeState === "BEHIND") return <StatusPill tone="warn">{t("prs.state.behind")}</StatusPill>;
  if (pr.mergeState === "UNSTABLE") return <StatusPill tone="warn">{t("prs.state.unstable")}</StatusPill>;
  return <span className="muted">{t("prs.state.unknown")}</span>;
}

// t() has no parameters, so translated strings carry {name} placeholders filled here.
function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

function since(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(iso).toLocaleDateString();
}
