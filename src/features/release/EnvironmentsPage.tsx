import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ArrowUpCircle, CheckCircle2, ExternalLink, GitCompareArrows, History, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { ActionButton } from "../../shared/ui/ActionButton";
import { Alert } from "../../shared/ui/Alert";
import { EmptyState } from "../../shared/ui/EmptyState";
import { ErrorState } from "../../shared/ui/ErrorState";
import { Modal } from "../../shared/ui/Modal";
import { PageHeader } from "../../shared/ui/PageHeader";
import { Skeleton } from "../../shared/ui/Skeleton";
import { StatusPill } from "../../shared/ui/StatusPill";
import { AddRepositoryButton, RepoPicker, useRepoSelection } from "../pullRequests/RepoPicker";
import { usePullRequestHub, type PullRequestRoute } from "../pullRequests/usePullRequests";
import type { HubStatus } from "../runners/useRunners";

// Mirrors kora/lib/environments.js.
export type Entry = { image: string; tag: string; sha: string | null; build: number | null; version: string | null; suffix: string | null };
type EnvState = { path: string; deployedAt: string | null; current: Entry | null; history: Entry[]; total: number };
type Env = "dev" | "stg" | "production";
type Service = { name: string; envs: Partial<Record<Env, EnvState>> };
export type Environments = { branch: string; services: Service[] };
export type Deployment = { url: string; number: number; title: string; merged: boolean };

const ENV_LABEL: Record<Env, string> = { dev: "Dev", stg: "Stage", production: "Prod" };

const hubTone: Record<HubStatus, "good" | "warn" | "neutral"> = {
  online: "good",
  connecting: "neutral",
  reconnecting: "warn",
  offline: "warn",
  unconfigured: "neutral"
};

type Hub = ReturnType<typeof usePullRequestHub>;

export function EnvironmentsPage() {
  const { t } = useT();
  const hub = usePullRequestHub();
  const selection = useRepoSelection(hub.repos, "deployment");
  const { route, selected } = selection;
  const environments = useQuery({
    queryKey: ["environments", route?.runnerId, selected?.github],
    queryFn: async () => (await hub.askGitHub("Environments", route!.runnerId, selected!.github)).environments as Environments,
    enabled: hub.status === "online" && Boolean(route && selected),
    retry: false,
    staleTime: 30_000,
    refetchInterval: 2 * 60_000
  });

  return (
    <section className="wide">
      <PageHeader
        title={t("env.title")}
        subtitle={t("env.subtitle")}
        actions={
          <>
            <StatusPill tone={hubTone[hub.status]}>{t(`runners.hub.${hub.status}`)}</StatusPill>
            <ActionButton
              variant="icon"
              onClick={() => (hub.status === "offline" ? hub.retry() : void environments.refetch())}
              title={t("common.refresh")}
              icon={<RefreshCw size={18} />}
            />
          </>
        }
      />

      {hub.status === "unconfigured" ? (
        <EmptyState icon={<GitCompareArrows size={22} />} title={t("runners.unconfigured.title")} description={t("runners.unconfigured.body")} />
      ) : hub.status === "offline" ? (
        <ErrorState message={hub.error || t("runners.offline")} onRetry={hub.retry} />
      ) : hub.status === "connecting" ? (
        <div className="panel">
          <Skeleton className="skeleton-line" />
          <Skeleton className="skeleton-line" />
        </div>
      ) : !selected || !route ? (
        <EmptyState
          icon={<GitCompareArrows size={22} />}
          title={t("deploy.noRepos.title")}
          description={t("deploy.noRepos.body")}
          action={<AddRepositoryButton hub={hub} onAdded={selection.selectRepo} deployment />}
        />
      ) : (
        <>
          <RepoPicker hub={hub} {...selection} selected={selected} route={route} />
          {environments.isError ? (
            <ErrorState message={environments.error.message} onRetry={() => void environments.refetch()} />
          ) : environments.isPending ? (
            <div className="panel">
              <Skeleton className="skeleton-line-lg" />
              <Skeleton className="skeleton-line" />
              <Skeleton className="skeleton-line" />
            </div>
          ) : environments.data.services.length === 0 ? (
            <EmptyState icon={<GitCompareArrows size={22} />} title={t("env.none.title")} description={t("env.none.body")} />
          ) : (
            <EnvironmentsTable hub={hub} route={route} repo={selected.github} data={environments.data} />
          )}
        </>
      )}
    </section>
  );
}

type Action = { service: Service; env: "stg" | "production"; kind: "promote" | "rollback" };

function EnvironmentsTable({ data, hub, repo, route }: { data: Environments; hub: Hub; repo: string; route: PullRequestRoute }) {
  const { t } = useT();
  const [action, setAction] = useState<Action | null>(null);
  const [done, setDone] = useState<Deployment | null>(null);

  return (
    <>
      {done ? (
        <Alert tone="info">
          {done.merged ? t("env.done.merged") : t("env.done.opened")}{" "}
          <a href={done.url} target="_blank" rel="noreferrer" className="link-button">
            #{done.number} {done.title} <ExternalLink size={12} />
          </a>
        </Alert>
      ) : null}
      <div className="table-shell">
        <table className="runners-table env-table">
          <thead>
            <tr>
              <th>{t("env.col.service")}</th>
              <th>{ENV_LABEL.dev}</th>
              <th className="env-gap" aria-label={t("env.col.compare")} />
              <th>{ENV_LABEL.stg}</th>
              <th className="env-gap" aria-label={t("env.col.compare")} />
              <th>{ENV_LABEL.production}</th>
            </tr>
          </thead>
          <tbody>
            {data.services.map((service) => (
              <tr key={service.name}>
                <td>
                  <strong>{service.name}</strong>
                </td>
                <td><EnvCell state={service.envs.dev} /></td>
                <td className="env-gap"><Drift source={service.envs.dev} target={service.envs.stg} /></td>
                <td>
                  <EnvCell state={service.envs.stg}>
                    <EnvActions service={service} env="stg" onAction={setAction} />
                  </EnvCell>
                </td>
                <td className="env-gap"><Drift source={service.envs.stg} target={service.envs.production} /></td>
                <td>
                  <EnvCell state={service.envs.production}>
                    <EnvActions service={service} env="production" onAction={setAction} />
                  </EnvCell>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted prs-identity">{fill(t("env.footer"), { branch: data.branch, account: route.githubAccount ?? "?", runner: route.runnerName })}</p>
      {action ? (
        <DeployDialog
          action={action}
          hub={hub}
          repo={repo}
          route={route}
          onClose={() => setAction(null)}
          onDone={(deployment) => {
            setAction(null);
            setDone(deployment);
          }}
        />
      ) : null}
    </>
  );
}

function EnvCell({ children, state }: { children?: ReactNode; state?: EnvState }) {
  const { t } = useT();
  if (!state?.current) return <span className="muted">{t("env.notDeployed")}</span>;
  return (
    <div className="runner-stack">
      <strong title={state.current.image}>{label(state.current)}</strong>
      <span className="muted mono-sm">
        {state.current.build ? `#${state.current.build} · ` : ""}
        {state.current.sha?.slice(0, 7) ?? state.current.tag}
      </span>
      {state.deployedAt ? <span className="muted" title={new Date(state.deployedAt).toLocaleString()}>{since(state.deployedAt)}</span> : null}
      {children}
    </div>
  );
}

function EnvActions({ env, onAction, service }: { env: "stg" | "production"; onAction: (action: Action) => void; service: Service }) {
  const { t } = useT();
  const source = service.envs[env === "stg" ? "dev" : "stg"];
  const target = service.envs[env];
  const canPromote = Boolean(source?.current && source.current.image !== target?.current?.image);
  const canRollback = Boolean(target && target.history.length > 1);
  return (
    <div className="env-actions">
      {canPromote ? (
        <button className="icon-button" onClick={() => onAction({ service, env, kind: "promote" })} title={fill(t("env.promote.hint"), { from: ENV_LABEL[env === "stg" ? "dev" : "stg"], to: ENV_LABEL[env] })}>
          <ArrowUpCircle size={14} /> {t("env.promote")}
        </button>
      ) : null}
      {canRollback ? (
        <button className="icon-button" onClick={() => onAction({ service, env, kind: "rollback" })}>
          <History size={14} /> {t("env.rollback")}
        </button>
      ) : null}
    </div>
  );
}

type DriftResult = { kind: "same" } | { kind: "behind"; count: number | null } | { kind: "ahead" } | { kind: "differs" } | { kind: "unknown" };

// How the later environment (target) stands against the earlier one (source). Position in the source history is the
// truth (build numbers are not always increasing); the version number is the fallback.
function drift(source?: EnvState, target?: EnvState): DriftResult {
  if (!source?.current || !target?.current) return { kind: "unknown" };
  if (source.current.image === target.current.image) return { kind: "same" };
  const index = source.history.findIndex((entry) => entry.image === target.current!.image);
  if (index > 0) return { kind: "behind", count: index };
  const order = compareVersions(target.current.version, source.current.version);
  if (order < 0) return { kind: "behind", count: null };
  if (order > 0) return { kind: "ahead" };
  return { kind: "differs" };
}

function Drift({ source, target }: { source?: EnvState; target?: EnvState }) {
  const { t } = useT();
  const result = drift(source, target);
  if (result.kind === "unknown") return <span className="muted">—</span>;
  if (result.kind === "same") return <span className="env-drift same" title={t("env.drift.sameHint")}><CheckCircle2 size={14} /> {t("env.drift.same")}</span>;
  if (result.kind === "behind")
    return (
      <span className="env-drift behind" title={t("env.drift.behindHint")}>
        <ArrowRight size={14} /> {result.count ? fill(t("env.drift.behindBy"), { count: result.count }) : t("env.drift.behind")}
      </span>
    );
  if (result.kind === "ahead") return <span className="env-drift ahead" title={t("env.drift.aheadHint")}>{t("env.drift.ahead")}</span>;
  return <span className="env-drift differs" title={t("env.drift.differsHint")}>{t("env.drift.differs")}</span>;
}

function DeployDialog({
  action,
  hub,
  onClose,
  onDone,
  repo,
  route
}: {
  action: Action;
  hub: Hub;
  onClose: () => void;
  onDone: (deployment: Deployment) => void;
  repo: string;
  route: PullRequestRoute;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const { env, kind, service } = action;
  const target = service.envs[env]!;
  const sourceEnv: Env = env === "stg" ? "dev" : "stg";
  const source = service.envs[sourceEnv];
  // Rollback offers this environment's earlier versions, newest first, without repeats of what runs now.
  const choices = kind === "rollback" ? uniqueImages(target.history).filter((entry) => entry.image !== target.current?.image) : [];
  const [image, setImage] = useState(kind === "promote" ? source?.current?.image ?? "" : choices[0]?.image ?? "");
  const [merge, setMerge] = useState(false);
  const chosen = kind === "promote" ? source?.current : choices.find((entry) => entry.image === image);
  // What a promote brings along: the source's versions newer than what the target runs.
  const index = source ? source.history.findIndex((entry) => entry.image === target.current?.image) : -1;
  const included = kind === "promote" && source && index > 0 ? source.history.slice(0, index) : [];

  const deploy = useMutation({
    mutationFn: async () =>
      (await hub.askGitHub("DeployEnvironment", route.runnerId, repo, { service: service.name, env, kind, image, merge })).deployment as Deployment,
    onSuccess: (deployment) => {
      void queryClient.invalidateQueries({ queryKey: ["environments"] });
      void queryClient.invalidateQueries({ queryKey: ["pull-requests"] });
      onDone(deployment);
    }
  });

  const title = kind === "promote" ? fill(t("env.promote.title"), { service: service.name, to: ENV_LABEL[env] }) : fill(t("env.rollback.title"), { service: service.name, env: ENV_LABEL[env] });

  return (
    <Modal title={title} onClose={onClose}>
      <div className="env-move">
        <div>
          <span className="muted">{t("env.now")}</span>
          <strong>{target.current ? label(target.current) : "—"}</strong>
        </div>
        <ArrowRight size={18} />
        <div>
          <span className="muted">{t("env.after")}</span>
          <strong>{chosen ? label(chosen) : "—"}</strong>
        </div>
      </div>

      {kind === "rollback" ? (
        <label className="form-field">
          <span>{t("env.rollback.pick")}</span>
          <select value={image} onChange={(event) => setImage(event.target.value)}>
            {choices.map((entry) => (
              <option key={entry.image} value={entry.image}>
                {label(entry)}{entry.build ? ` · #${entry.build}` : ""}{entry.sha ? ` · ${entry.sha.slice(0, 7)}` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : included.length > 1 ? (
        <div className="form-field">
          <span>{fill(t("env.promote.includes"), { count: included.length })}</span>
          <div className="chips">{included.map((entry) => <span className="chip" key={entry.image}>{label(entry)}</span>)}</div>
        </div>
      ) : null}

      <p className="muted">{fill(t("env.dialog.how"), { path: target.path })}</p>
      {env === "production" ? <Alert tone="warn">{t("env.prodWarning")}</Alert> : null}
      <label className="checkbox-field">
        <input type="checkbox" checked={merge} onChange={(event) => setMerge(event.target.checked)} />
        <span>{fill(t("env.mergeNow"), { env: ENV_LABEL[env] })}</span>
      </label>
      <p className="muted">{fill(t("prs.identity"), { account: route.githubAccount ?? "?", runner: route.runnerName })}</p>
      {deploy.isError ? <Alert tone="error">{deploy.error.message}</Alert> : null}
      <div className="modal-actions">
        <button className="icon-button" onClick={onClose}>{t("common.cancel")}</button>
        <button className={`primary-button${kind === "rollback" ? " danger" : ""}`} disabled={!image || deploy.isPending} onClick={() => deploy.mutate()}>
          {kind === "promote" ? <ArrowUpCircle size={16} /> : <History size={16} />}
          {deploy.isPending ? t("prs.working") : merge ? t("env.submit.merge") : t("env.submit.pr")}
        </button>
      </div>
    </Modal>
  );
}

export function uniqueImages(entries: Entry[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => (seen.has(entry.image) ? false : (seen.add(entry.image), true)));
}

export function label(entry: Entry) {
  return entry.version ?? (entry.build ? `build ${entry.build}` : entry.tag.slice(0, 12));
}

function compareVersions(a: string | null, b: string | null) {
  if (!a || !b) return 0;
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

function since(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(iso).toLocaleDateString();
}

// t() has no parameters, so translated strings carry {name} placeholders filled here.
function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
