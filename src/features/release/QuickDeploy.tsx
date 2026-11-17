import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, RotateCcw, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { Alert } from "../../shared/ui/Alert";
import { Skeleton } from "../../shared/ui/Skeleton";
import type { PullRequestRoute, usePullRequestHub } from "../pullRequests/usePullRequests";
import { label, uniqueImages, type Deployment, type Entry, type Environments } from "./EnvironmentsPage";

type Hub = ReturnType<typeof usePullRequestHub>;
type Target = "stg" | "production";

// Services ticked the first time a deployment repo is opened, when it has them.
const DEFAULT_SERVICES = ["webservice", "webhost", "webclient"];
const servicesKey = (repo: string) => `blocks-app:quick-deploy:${repo.toLowerCase()}`;
const mergeKey = "blocks-app:quick-deploy-merge";

type RowResult = { state: "working" } | { state: "done"; deployment: Deployment } | { state: "failed"; message: string };

// Release > Deploy to stage / prod: every ticked service with its newest version (what dev runs) chosen, one button
// to open (and merge) a deploy PR for each. A version picked by hand sticks until it is reset; the rest follow the
// newest build as it lands.
export function QuickDeploy({ env, hub, repo, route }: { env: Target; hub: Hub; repo: string; route: PullRequestRoute }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const environments = useQuery({
    queryKey: ["environments", route.runnerId, repo],
    queryFn: async () => (await hub.askGitHub("Environments", route.runnerId, repo)).environments as Environments,
    enabled: hub.status === "online",
    retry: false,
    staleTime: 30_000,
    refetchInterval: 60_000
  });
  const services = environments.data?.services ?? [];
  const [ticked, setTicked] = useState<string[] | null>(() => readJson(servicesKey(repo)));
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [merge, setMerge] = useState(() => readJson<boolean>(mergeKey) ?? true);
  const [confirming, setConfirming] = useState(false);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setTicked(readJson(servicesKey(repo)));
    setPicked({});
    setResults({});
  }, [repo]);

  const names = services.map((service) => service.name);
  const chosenNames = ticked ?? (names.some((name) => DEFAULT_SERVICES.includes(name)) ? names.filter((name) => DEFAULT_SERVICES.includes(name)) : names);

  const rows = services.map((service) => {
    // Newest first: dev's history (every build lands there), then anything stage or prod ran that dev no longer lists.
    const versions = uniqueImages([...(service.envs.dev?.history ?? []), ...(service.envs.stg?.history ?? []), ...(service.envs.production?.history ?? [])]);
    const latest = service.envs.dev?.current ?? versions[0] ?? null;
    const current = service.envs[env]?.current ?? null;
    const image = picked[service.name] && versions.some((entry) => entry.image === picked[service.name]) ? picked[service.name]! : latest?.image ?? "";
    const chosen = versions.find((entry) => entry.image === image) ?? null;
    return { name: service.name, versions, latest, current, image, chosen, hasFile: Boolean(service.envs[env]), on: chosenNames.includes(service.name) };
  });
  const toDeploy = rows.filter((row) => row.on && row.hasFile && row.chosen && row.image !== row.current?.image);
  const envLabel = env === "stg" ? "Stage" : "Prod";

  function toggle(name: string) {
    const next = chosenNames.includes(name) ? chosenNames.filter((entry) => entry !== name) : [...chosenNames, name];
    setTicked(next);
    writeJson(servicesKey(repo), next);
  }

  async function deploy() {
    if (env === "production" && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setRunning(true);
    const batch = toDeploy.slice();
    setResults(Object.fromEntries(batch.map((row) => [row.name, { state: "working" } as RowResult])));
    // One at a time: each PR is a commit on the same branch of the deployment repo.
    for (const row of batch) {
      try {
        const answer = await hub.askGitHub("DeployEnvironment", route.runnerId, repo, { service: row.name, env, kind: "deploy", image: row.image, merge });
        setResults((before) => ({ ...before, [row.name]: { state: "done", deployment: answer.deployment as Deployment } }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setResults((before) => ({
          ...before,
          [row.name]: { state: "failed", message: /Unknown deployment kind/i.test(message) ? t("quick.koraTooOld") : message }
        }));
      }
    }
    setRunning(false);
    setPicked({});
    void queryClient.invalidateQueries({ queryKey: ["environments"] });
    void queryClient.invalidateQueries({ queryKey: ["pull-requests"] });
  }

  if (environments.isError) return <Alert tone="error">{environments.error.message}</Alert>;
  if (environments.isPending) {
    return (
      <div className="panel">
        <Skeleton className="skeleton-line-lg" />
        <Skeleton className="skeleton-line" />
      </div>
    );
  }
  if (services.length === 0) return null;

  return (
    <div className="panel quick-deploy">
      <div className="quick-head">
        <h2>
          <Zap size={18} /> {fill(t("quick.title"), { env: envLabel })}
        </h2>
        <div className="chips">
          {names.map((name) => (
            <label key={name} className={`chip chip-toggle${chosenNames.includes(name) ? " on" : ""}`}>
              <input type="checkbox" checked={chosenNames.includes(name)} onChange={() => toggle(name)} disabled={running} />
              {name}
            </label>
          ))}
        </div>
      </div>

      <div className="table-shell">
        <table className="runners-table quick-table">
          <thead>
            <tr>
              <th>{t("env.col.service")}</th>
              <th>{fill(t("quick.col.runs"), { env: envLabel })}</th>
              <th>{t("quick.col.deploy")}</th>
              <th aria-label={t("quick.col.result")} />
            </tr>
          </thead>
          <tbody>
            {rows.filter((row) => row.on).map((row) => {
              const result = results[row.name];
              const isLatest = row.image === row.latest?.image;
              return (
                <tr key={row.name}>
                  <td><strong>{row.name}</strong></td>
                  <td>{row.current ? <span title={row.current.image}>{label(row.current)}</span> : <span className="muted">{t("env.notDeployed")}</span>}</td>
                  <td>
                    {!row.hasFile ? (
                      <span className="muted">{fill(t("quick.noFile"), { env: envLabel })}</span>
                    ) : (
                      <div className="quick-pick">
                        <select
                          value={row.image}
                          disabled={running}
                          onChange={(event) => setPicked((before) => ({ ...before, [row.name]: event.target.value }))}
                        >
                          {row.versions.map((entry) => (
                            <option key={entry.image} value={entry.image}>
                              {optionLabel(entry)}
                              {entry.image === row.latest?.image ? ` — ${t("quick.latest")}` : ""}
                              {entry.image === row.current?.image ? ` — ${fill(t("quick.running"), { env: envLabel })}` : ""}
                            </option>
                          ))}
                        </select>
                        {isLatest ? (
                          <span className="quick-badge">{t("quick.latest")}</span>
                        ) : (
                          <button className="icon-button" onClick={() => setPicked(({ [row.name]: _drop, ...rest }) => rest)} title={t("quick.backToLatest")} disabled={running}>
                            <RotateCcw size={14} />
                          </button>
                        )}
                        {row.image === row.current?.image ? <span className="muted">{t("quick.upToDate")}</span> : null}
                      </div>
                    )}
                  </td>
                  <td>
                    {result?.state === "working" ? (
                      <span className="muted">{t("prs.working")}</span>
                    ) : result?.state === "done" ? (
                      <a href={result.deployment.url} target="_blank" rel="noreferrer" className="link-button">
                        <CheckCircle2 size={14} /> #{result.deployment.number} {result.deployment.merged ? t("quick.merged") : t("quick.opened")} <ExternalLink size={12} />
                      </a>
                    ) : result?.state === "failed" ? (
                      <span className="error-text">{result.message}</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {env === "production" ? <Alert tone="warn">{t("env.prodWarning")}</Alert> : null}
      <div className="quick-actions">
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={merge}
            disabled={running}
            onChange={(event) => {
              setMerge(event.target.checked);
              writeJson(mergeKey, event.target.checked);
            }}
          />
          <span>{fill(t("env.mergeNow"), { env: envLabel })}</span>
        </label>
        {confirming ? (
          <button className="icon-button" onClick={() => setConfirming(false)}>{t("common.cancel")}</button>
        ) : null}
        <button className={`primary-button${env === "production" ? " danger" : ""}`} disabled={running || toDeploy.length === 0} onClick={() => void deploy()}>
          <Zap size={16} />
          {running
            ? t("prs.working")
            : toDeploy.length === 0
              ? t("quick.nothing")
              : fill(t(confirming ? "quick.confirm" : "quick.deploy"), { count: toDeploy.length, env: envLabel })}
        </button>
      </div>
    </div>
  );
}

function optionLabel(entry: Entry) {
  return `${label(entry)}${entry.build ? ` · #${entry.build}` : ""}${entry.sha ? ` · ${entry.sha.slice(0, 7)}` : ""}`;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Remembering the choice is a convenience only.
  }
}

function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
