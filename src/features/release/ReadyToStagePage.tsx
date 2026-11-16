import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CheckCircle2, CircleDashed, ExternalLink, GitMerge, Layers, Loader2, RefreshCw, Square, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DragEvent, ReactNode } from "react";
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
import { AddRepositoryButton, RepoPicker, useRepoSelection } from "../pullRequests/RepoPicker";
import { usePullRequestHub, type MergeMethod, type PullRequest, type PullRequestRoute } from "../pullRequests/usePullRequests";
import type { HubStatus } from "../runners/useRunners";
import {
  DEPLOYED_LABEL,
  READY_LABEL,
  useMergeQueue,
  useReleaseBoard,
  useSetReady,
  type MergedPullRequest,
  type MergeQueue,
  type QueueItem
} from "./useReleaseBoard";

const hubTone: Record<HubStatus, "good" | "warn" | "neutral"> = {
  online: "good",
  connecting: "neutral",
  reconnecting: "warn",
  offline: "warn",
  unconfigured: "neutral"
};

const MERGE_METHOD_KEY = "blocks-app:prs-merge-method"; // shared with the PRs page
const orderKey = (repo: string) => `blocks-app:stage-order:${repo.toLowerCase()}`;

type Hub = ReturnType<typeof usePullRequestHub>;

export function ReadyToStagePage() {
  const { t } = useT();
  const hub = usePullRequestHub();
  const selection = useRepoSelection(hub.repos);
  const { route, selected } = selection;
  const board = useReleaseBoard(hub, route, selected?.github);

  return (
    <section className="wide">
      <PageHeader
        title={t("release.stage.title")}
        subtitle={t("release.stage.subtitle")}
        actions={
          <>
            <StatusPill tone={hubTone[hub.status]}>{t(`runners.hub.${hub.status}`)}</StatusPill>
            <ActionButton
              variant="icon"
              onClick={() => (hub.status === "offline" ? hub.retry() : void board.refetch())}
              title={t("common.refresh")}
              icon={<RefreshCw size={18} />}
            />
          </>
        }
      />

      {hub.status === "unconfigured" ? (
        <EmptyState icon={<Layers size={22} />} title={t("runners.unconfigured.title")} description={t("runners.unconfigured.body")} />
      ) : hub.status === "offline" ? (
        <ErrorState message={hub.error || t("runners.offline")} onRetry={hub.retry} />
      ) : hub.status === "connecting" ? (
        <div className="panel">
          <Skeleton className="skeleton-line" />
          <Skeleton className="skeleton-line" />
        </div>
      ) : !selected || !route ? (
        <EmptyState
          icon={<Layers size={22} />}
          title={t("prs.noRepos.title")}
          description={t("prs.noRepos.body")}
          action={<AddRepositoryButton hub={hub} onAdded={selection.selectRepo} />}
        />
      ) : (
        <>
          <RepoPicker hub={hub} {...selection} selected={selected} route={route} />
          {board.isError ? (
            <ErrorState message={board.error.message} onRetry={() => void board.refetch()} />
          ) : board.isPending ? (
            <div className="stage-board">
              {[0, 1, 2, 3].map((column) => (
                <div className="stage-column" key={column}>
                  <Skeleton className="skeleton-line" />
                  <Skeleton className="skeleton-line-lg" />
                </div>
              ))}
            </div>
          ) : (
            // Keyed so each repository keeps its own Ready order and queue view.
            <Board key={`${route.runnerId}:${selected.github}`} hub={hub} route={route} repo={selected.github} open={board.data.open} merged={board.data.merged} />
          )}
        </>
      )}
    </section>
  );
}

function Board({ hub, merged, open, repo, route }: { hub: Hub; merged: MergedPullRequest[]; open: PullRequest[]; repo: string; route: PullRequestRoute }) {
  const { t } = useT();
  const setReady = useSetReady(hub, route, repo);
  const queue = useMergeQueue(hub, repo);
  const [order, setOrder] = useState<number[]>(() => readOrder(repo));
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<"open" | "ready" | null>(null);
  const [merging, setMerging] = useState(false);

  const running = queue?.status === "running" ? queue : null;
  const inQueue = new Map((running?.items ?? []).map((item) => [item.number, item]));
  const lastQueueItems = new Map((queue?.items ?? []).map((item) => [item.number, item]));

  const backlog = open.filter((pr) => !pr.labels.includes(READY_LABEL));
  // Ready keeps the order the user set (merge order); new arrivals go to the end, oldest PR first.
  const ready = useMemo(() => {
    const rank = (n: number) => (order.includes(n) ? order.indexOf(n) : order.length + n / 1e9);
    return open.filter((pr) => pr.labels.includes(READY_LABEL)).sort((a, b) => rank(a.number) - rank(b.number));
  }, [open, order]);
  const mergedOnly = merged.filter((pr) => !pr.labels.includes(DEPLOYED_LABEL));
  const deployed = merged.filter((pr) => pr.labels.includes(DEPLOYED_LABEL));

  useEffect(() => {
    try {
      localStorage.setItem(orderKey(repo), JSON.stringify(order));
    } catch {
      // ordering is a convenience; the board works without it
    }
  }, [order, repo]);

  function move(number: number, toReady: boolean) {
    if (inQueue.has(number)) return;
    if (toReady) setOrder((current) => [...current.filter((n) => n !== number), number]);
    setReady.mutate({ number, ready: toReady });
  }

  function shift(number: number, by: -1 | 1) {
    const numbers = ready.map((pr) => pr.number);
    const index = numbers.indexOf(number);
    const target = index + by;
    if (target < 0 || target >= numbers.length) return;
    [numbers[index], numbers[target]] = [numbers[target]!, numbers[index]!];
    setOrder(numbers);
  }

  const dropZone = (column: "open" | "ready") => ({
    onDragOver: (event: DragEvent) => {
      if (dragging === null) return;
      event.preventDefault();
      setOver(column);
    },
    onDragLeave: () => setOver(null),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setOver(null);
      const number = Number(event.dataTransfer.getData("text/plain"));
      const fromReady = ready.some((pr) => pr.number === number);
      if (number && fromReady !== (column === "ready")) move(number, column === "ready");
    }
  });

  const dragProps = (number: number) => ({
    draggable: !inQueue.has(number),
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData("text/plain", String(number));
      event.dataTransfer.effectAllowed = "move";
      setDragging(number);
    },
    onDragEnd: () => {
      setDragging(null);
      setOver(null);
    }
  });

  return (
    <>
      {queue ? <QueuePanel hub={hub} queue={queue} /> : null}
      {setReady.isError ? <Alert tone="error">{setReady.error.message}</Alert> : null}

      <div className="stage-board">
        <Column
          title={t("release.col.open")}
          hint={t("release.col.openHint")}
          count={backlog.length}
          className={over === "open" ? "drop" : ""}
          zone={dropZone("open")}
        >
          {backlog.map((pr) => (
            <Card key={pr.number} pr={pr} drag={dragProps(pr.number)} dragging={dragging === pr.number}>
              <button className="icon-button card-action" onClick={() => move(pr.number, true)} title={t("release.toReady")}>
                <ArrowRight size={15} />
              </button>
            </Card>
          ))}
        </Column>

        <Column
          title={t("release.col.ready")}
          hint={t("release.col.readyHint")}
          count={ready.length}
          className={`ready${over === "ready" ? " drop" : ""}`}
          zone={dropZone("ready")}
          action={
            <button className="primary-button" disabled={!ready.length || Boolean(running)} onClick={() => setMerging(true)} title={running ? t("release.queueRunning") : undefined}>
              <GitMerge size={16} /> {fill(t("release.mergeAll"), { count: ready.length })}
            </button>
          }
        >
          {ready.map((pr, index) => {
            const item = inQueue.get(pr.number);
            return (
              <Card key={pr.number} pr={pr} drag={dragProps(pr.number)} dragging={dragging === pr.number} position={index + 1} queueItem={item}>
                {item ? null : (
                  <>
                    <button className="icon-button card-action" onClick={() => shift(pr.number, -1)} disabled={index === 0} title={t("release.up")}>
                      <ArrowUp size={15} />
                    </button>
                    <button className="icon-button card-action" onClick={() => shift(pr.number, 1)} disabled={index === ready.length - 1} title={t("release.down")}>
                      <ArrowDown size={15} />
                    </button>
                    <button className="icon-button card-action" onClick={() => move(pr.number, false)} title={t("release.toOpen")}>
                      <ArrowLeft size={15} />
                    </button>
                  </>
                )}
              </Card>
            );
          })}
        </Column>

        <Column title={t("release.col.merged")} hint={t("release.col.mergedHint")} count={mergedOnly.length}>
          {mergedOnly.map((pr) => <MergedCard key={pr.number} pr={pr} queueItem={lastQueueItems.get(pr.number)} />)}
        </Column>

        <Column title={t("release.col.deployed")} hint={t("release.col.deployedHint")} count={deployed.length}>
          {deployed.map((pr) => <MergedCard key={pr.number} pr={pr} queueItem={lastQueueItems.get(pr.number)} />)}
        </Column>
      </div>
      <p className="muted prs-identity">{fill(t("prs.identity"), { account: route.githubAccount ?? "?", runner: route.runnerName })}</p>

      {merging ? <MergeQueueDialog hub={hub} route={route} repo={repo} prs={ready} onClose={() => setMerging(false)} /> : null}
    </>
  );
}

function Column({
  action,
  children,
  className = "",
  count,
  hint,
  title,
  zone
}: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  count: number;
  hint: string;
  title: string;
  zone?: { onDragOver: (event: DragEvent) => void; onDragLeave: () => void; onDrop: (event: DragEvent) => void };
}) {
  const { t } = useT();
  const empty = Array.isArray(children) ? children.length === 0 : !children;
  return (
    <div className={`stage-column ${className}`.trim()} {...zone}>
      <div className="stage-column-head">
        <div>
          <h3>{title} <span className="stage-count">{count}</span></h3>
          <span className="muted">{hint}</span>
        </div>
        {action}
      </div>
      <div className="stage-cards">{empty ? <div className="stage-empty muted">{t("release.empty")}</div> : children}</div>
    </div>
  );
}

function Card({
  children,
  drag,
  dragging,
  position,
  pr,
  queueItem
}: {
  children?: ReactNode;
  drag: { draggable: boolean; onDragStart: (event: DragEvent) => void; onDragEnd: () => void };
  dragging: boolean;
  position?: number;
  pr: PullRequest;
  queueItem?: QueueItem;
}) {
  const { t } = useT();
  return (
    <article className={`stage-card${dragging ? " dragging" : ""}${drag.draggable ? "" : " locked"}`} {...drag}>
      <div className="stage-card-top">
        {position ? <span className="stage-position">{position}</span> : null}
        <a href={pr.url} target="_blank" rel="noreferrer" className="stage-card-title" draggable={false}>
          <span className="muted">#{pr.number}</span> {pr.title}
        </a>
        <div className="stage-card-actions">{children}</div>
      </div>
      <span className="muted mono-sm">{pr.head} → {pr.base}</span>
      <div className="chips">
        <span className="muted">{pr.author ?? "—"}</span>
        {pr.isDraft ? <span className="chip">{t("prs.draft")}</span> : null}
        {pr.mergeable === "CONFLICTING" ? <StatusPill tone="warn">{t("prs.state.conflicts")}</StatusPill> : null}
        {pr.reviewDecision === "APPROVED" ? <StatusPill tone="good">{t("prs.review.approved")}</StatusPill> : null}
        {pr.reviewDecision === "CHANGES_REQUESTED" ? <StatusPill tone="warn">{t("prs.review.changes")}</StatusPill> : null}
        {pr.checks.failed ? <StatusPill tone="warn">{fill(t("prs.checks.failed"), { count: pr.checks.failed })}</StatusPill> : null}
      </div>
      {queueItem ? <QueueState item={queueItem} /> : null}
    </article>
  );
}

function MergedCard({ pr, queueItem }: { pr: MergedPullRequest; queueItem?: QueueItem }) {
  return (
    <article className="stage-card locked">
      <a href={pr.url} target="_blank" rel="noreferrer" className="stage-card-title">
        <span className="muted">#{pr.number}</span> {pr.title} <ExternalLink size={12} />
      </a>
      <span className="muted mono-sm">
        {pr.base}
        {pr.mergeCommit ? ` @ ${pr.mergeCommit.slice(0, 7)}` : ""}
      </span>
      <span className="muted">{pr.author ?? "—"} · {new Date(pr.mergedAt).toLocaleString()}</span>
      {queueItem ? <QueueState item={queueItem} /> : null}
    </article>
  );
}

const stateIcon: Record<QueueItem["state"], ReactNode> = {
  pending: <CircleDashed size={14} />,
  merging: <Loader2 size={14} className="spin" />,
  updating: <Loader2 size={14} className="spin" />,
  building: <Loader2 size={14} className="spin" />,
  deployed: <CheckCircle2 size={14} />,
  merged: <CheckCircle2 size={14} />,
  failed: <XCircle size={14} />,
  skipped: <CircleDashed size={14} />
};

function QueueState({ item }: { item: QueueItem }) {
  const { t } = useT();
  return (
    <div className={`queue-state queue-${item.state}`}>
      {stateIcon[item.state]}
      <span>
        <strong>{t(`release.state.${item.state}` as TranslationKey)}</strong>
        {item.message ? ` — ${item.message}` : ""}
        {item.runs?.length ? <span className="muted"> · {item.runs.map((run) => `${run.name}: ${run.conclusion ?? run.status}`).join(", ")}</span> : null}
      </span>
      {item.runUrl ? (
        <a href={item.runUrl} target="_blank" rel="noreferrer" title={t("release.openRun")}>
          <ExternalLink size={13} />
        </a>
      ) : null}
    </div>
  );
}

function QueuePanel({ hub, queue }: { hub: Hub; queue: MergeQueue }) {
  const { t } = useT();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = queue.items.filter((item) => item.state === "deployed" || item.state === "merged").length;
  const tone = queue.status === "running" ? "neutral" : queue.status === "succeeded" ? "good" : "warn";

  async function cancel() {
    setCancelling(true);
    setError(null);
    try {
      await hub.invoke("CancelMergeQueue", queue.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setCancelling(false);
    }
  }

  return (
    <div className="panel queue-panel">
      <div className="queue-panel-head">
        <div>
          <strong>{t("release.queue.title")}</strong>{" "}
          <StatusPill tone={tone}>{t(`release.queue.${queue.status}` as TranslationKey)}</StatusPill>
          <div className="muted">
            {fill(t("release.queue.meta"), {
              done,
              total: queue.items.length,
              who: queue.startedBy.email || queue.startedBy.name || queue.startedBy.sub,
              runner: queue.runnerName,
              method: queue.method
            })}
          </div>
        </div>
        {queue.status === "running" ? (
          <button className="icon-button" onClick={() => void cancel()} disabled={cancelling} title={t("release.queue.cancelHint")}>
            <Square size={14} /> {cancelling ? t("release.queue.cancelling") : t("release.queue.cancel")}
          </button>
        ) : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <ol className="queue-list">
        {queue.items.map((item) => (
          <li key={item.number}>
            <span className="queue-pr">#{item.number} {item.title}</span>
            <QueueState item={item} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function MergeQueueDialog({ hub, onClose, prs, repo, route }: { hub: Hub; onClose: () => void; prs: PullRequest[]; repo: string; route: PullRequestRoute }) {
  const { t } = useT();
  const [method, setMethod] = useState<MergeMethod>(() => (localStorage.getItem(MERGE_METHOD_KEY) as MergeMethod | null) ?? "squash");
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = prs.filter((pr) => pr.isDraft || pr.mergeable === "CONFLICTING");
  const notReady = prs.filter((pr) => pr.reviewDecision !== "APPROVED" || pr.checks.failed > 0 || pr.checks.pending > 0);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(MERGE_METHOD_KEY, method);
      await hub.invoke("StartMergeQueue", route.runnerId, repo, prs.map((pr) => ({ number: pr.number, title: pr.title })), method, deleteBranch);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  }

  return (
    <Modal title={fill(t("release.merge.title"), { count: prs.length })} onClose={onClose}>
      <p>{t("release.merge.body")}</p>
      <ol className="queue-list">
        {prs.map((pr) => (
          <li key={pr.number}>
            <span className="queue-pr">#{pr.number} {pr.title}</span>
          </li>
        ))}
      </ol>
      {blocked.length ? (
        <Alert tone="error">{fill(t("release.merge.blocked"), { prs: blocked.map((pr) => `#${pr.number}`).join(", ") })}</Alert>
      ) : notReady.length ? (
        <Alert tone="warn">{fill(t("release.merge.notReady"), { prs: notReady.map((pr) => `#${pr.number}`).join(", ") })}</Alert>
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
        <span>{t("release.merge.deleteBranches")}</span>
      </label>
      <p className="muted">{fill(t("prs.identity"), { account: route.githubAccount ?? "?", runner: route.runnerName })}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="modal-actions">
        <button className="icon-button" onClick={onClose}>{t("common.cancel")}</button>
        <button className="primary-button" disabled={busy || blocked.length > 0} onClick={() => void start()}>
          <GitMerge size={16} /> {busy ? t("prs.working") : t("release.merge.start")}
        </button>
      </div>
    </Modal>
  );
}

function readOrder(repo: string): number[] {
  try {
    const saved = JSON.parse(localStorage.getItem(orderKey(repo)) ?? "[]");
    return Array.isArray(saved) ? saved.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

// t() has no parameters, so translated strings carry {name} placeholders filled here.
function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
