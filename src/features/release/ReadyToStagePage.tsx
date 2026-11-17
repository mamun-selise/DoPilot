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
import { useBoardCards, useBoardChange, type BoardCard, type BoardColumn } from "./boardCards";
import { useMergeQueue, useReleaseBoard, type MergedPullRequest, type MergeQueue, type QueueItem } from "./useReleaseBoard";

const hubTone: Record<HubStatus, "good" | "warn" | "neutral"> = {
  online: "good",
  connecting: "neutral",
  reconnecting: "warn",
  offline: "warn",
  unconfigured: "neutral"
};

const MERGE_METHOD_KEY = "blocks-app:merge-method"; // shared with the PRs page

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
  const cardsQuery = useBoardCards(repo);
  const change = useBoardChange(repo);
  const queue = useMergeQueue(hub, repo);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<"open" | "ready" | null>(null);
  const [merging, setMerging] = useState(false);

  const running = queue?.status === "running" ? queue : null;
  const inQueue = new Map((running?.items ?? []).map((item) => [item.number, item]));
  const lastQueueItems = new Map((queue?.items ?? []).map((item) => [item.number, item]));

  const cards = cardsQuery.data ?? [];
  const cardOf = new Map(cards.map((card) => [card.number, card]));
  const openOf = new Map(open.map((pr) => [pr.number, pr]));
  const mergedOf = new Map(merged.map((pr) => [pr.number, pr]));
  const newest = (a: BoardCard, b: BoardCard) => (b.LastUpdatedDate ?? "").localeCompare(a.LastUpdatedDate ?? "");

  const backlog = open.filter((pr) => cardOf.get(pr.number)?.column !== "ready");
  // Ready keeps the order set on the board (the merge order), top first.
  const readyCards = cards.filter((card) => card.column === "ready" && openOf.has(card.number)).sort((a, b) => a.position - b.position);
  const ready = readyCards.map((card) => openOf.get(card.number)!);
  // A Ready card whose PR got merged some other way counts as merged.
  const mergedCards = cards.filter((card) => card.column === "merged" || (card.column === "ready" && mergedOf.has(card.number))).sort(newest);
  const deployedCards = cards.filter((card) => card.column === "deployed").sort(newest).slice(0, 30);

  const view = (card: BoardCard): MergedView => {
    const pr = mergedOf.get(card.number);
    return {
      number: card.number,
      title: pr?.title ?? card.title,
      url: pr?.url ?? card.url,
      author: pr?.author ?? null,
      base: pr?.base ?? null,
      mergedAt: pr?.mergedAt ?? null,
      commit: card.commit ?? pr?.mergeCommit ?? null
    };
  };

  // The merge queue reports each PR's progress; record merged / deployed on its card. Every watching browser does
  // this and the result is the same, so it does not matter which one saves first.
  useEffect(() => {
    if (!queue || !cardsQuery.data) return;
    for (const item of queue.items) {
      const column: BoardColumn | null =
        item.state === "deployed" ? "deployed" : item.state === "building" || item.state === "merged" || (item.state === "failed" && item.commit) ? "merged" : null;
      if (!column) continue;
      const card = cardOf.get(item.number);
      if (card?.ItemId.startsWith("pending-")) continue;
      if (card && card.column === column && (!item.commit || card.commit === item.commit)) continue;
      if (card) change.mutate({ kind: "update", card, patch: { column, commit: item.commit ?? card.commit } });
      else change.mutate({ kind: "add", number: item.number, title: item.title, url: `https://github.com/${repo}/pull/${item.number}`, column, position: 0, movedBy: null });
    }
  }, [queue, cardsQuery.data]);

  function move(number: number, toReady: boolean) {
    if (inQueue.has(number)) return;
    const card = cardOf.get(number);
    if (!toReady) {
      if (card) change.mutate({ kind: "remove", card });
      return;
    }
    const pr = openOf.get(number);
    if (!pr) return;
    const position = readyCards.reduce((max, entry) => Math.max(max, entry.position), 0) + 1;
    if (card) change.mutate({ kind: "update", card, patch: { column: "ready", position, title: pr.title, url: pr.url } });
    else change.mutate({ kind: "add", number, title: pr.title, url: pr.url, column: "ready", position, movedBy: null });
  }

  // Swaps two neighbours; positions are re-numbered 1..n so the order stays exact after any number of moves.
  function shift(number: number, by: -1 | 1) {
    const order = readyCards.slice();
    const index = order.findIndex((card) => card.number === number);
    const target = index + by;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    order.forEach((card, i) => {
      if (card.position !== i + 1 && !card.ItemId.startsWith("pending-")) change.mutate({ kind: "update", card, patch: { position: i + 1 } });
    });
  }

  function markDeployed(card: BoardCard) {
    change.mutate({ kind: "update", card, patch: { column: "deployed" } });
  }

  if (cardsQuery.isError) return <ErrorState message={cardsQuery.error.message} onRetry={() => void cardsQuery.refetch()} />;
  if (cardsQuery.isPending) {
    return (
      <div className="stage-board">
        {[0, 1, 2, 3].map((column) => (
          <div className="stage-column" key={column}>
            <Skeleton className="skeleton-line" />
            <Skeleton className="skeleton-line-lg" />
          </div>
        ))}
      </div>
    );
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
      {change.isError ? <Alert tone="error">{change.error.message}</Alert> : null}

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

        <Column title={t("release.col.merged")} hint={t("release.col.mergedHint")} count={mergedCards.length}>
          {mergedCards.map((card) => (
            <MergedCard key={card.number} pr={view(card)} queueItem={lastQueueItems.get(card.number)}>
              {inQueue.has(card.number) || card.ItemId.startsWith("pending-") ? null : (
                <button className="icon-button card-action" onClick={() => markDeployed(card)} title={t("release.markDeployed")}>
                  <CheckCircle2 size={15} />
                </button>
              )}
            </MergedCard>
          ))}
        </Column>

        <Column title={t("release.col.deployed")} hint={t("release.col.deployedHint")} count={deployedCards.length}>
          {deployedCards.map((card) => <MergedCard key={card.number} pr={view(card)} queueItem={lastQueueItems.get(card.number)} />)}
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

// A merged / deployed card: details from GitHub when the PR is among the recently merged, else what the card saved.
type MergedView = { number: number; title: string; url: string; author: string | null; base: string | null; mergedAt: string | null; commit: string | null };

function MergedCard({ children, pr, queueItem }: { children?: ReactNode; pr: MergedView; queueItem?: QueueItem }) {
  return (
    <article className="stage-card locked">
      <div className="stage-card-top">
        <a href={pr.url} target="_blank" rel="noreferrer" className="stage-card-title">
          <span className="muted">#{pr.number}</span> {pr.title} <ExternalLink size={12} />
        </a>
        {children ? <div className="stage-card-actions">{children}</div> : null}
      </div>
      <span className="muted mono-sm">
        {pr.base ?? ""}
        {pr.commit ? ` @ ${pr.commit.slice(0, 7)}` : ""}
      </span>
      {pr.author || pr.mergedAt ? (
        <span className="muted">{pr.author ?? "—"}{pr.mergedAt ? ` · ${new Date(pr.mergedAt).toLocaleString()}` : ""}</span>
      ) : null}
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
  const [method, setMethod] = useState<MergeMethod>(() => (localStorage.getItem(MERGE_METHOD_KEY) as MergeMethod | null) ?? "merge");
  const [deleteBranch, setDeleteBranch] = useState(false);
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
          <option value="merge">{t("prs.merge.commit")}</option>
          <option value="squash">{t("prs.merge.squash")}</option>
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

// t() has no parameters, so translated strings carry {name} placeholders filled here.
function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
