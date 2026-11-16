import { ExternalLink, RefreshCw, RotateCcw, Save, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { TranslationKey } from "../../lib/i18n/dictionary";
import { ActionButton } from "../../shared/ui/ActionButton";
import { Alert } from "../../shared/ui/Alert";
import { EmptyState } from "../../shared/ui/EmptyState";
import { ErrorState } from "../../shared/ui/ErrorState";
import { PageHeader } from "../../shared/ui/PageHeader";
import { Skeleton } from "../../shared/ui/Skeleton";
import { StatusPill } from "../../shared/ui/StatusPill";
import { RepoPicker, useRepoSelection } from "../pullRequests/RepoPicker";
import { usePullRequestHub, type PullRequestRoute } from "../pullRequests/usePullRequests";
import type { HubStatus } from "../runners/useRunners";
import { useRepoSettings, useSaveRepoSettings, type RepoSettings, type SettingsChanges, type SwitchKey } from "./useRepoSettings";

const hubTone: Record<HubStatus, "good" | "warn" | "neutral"> = {
  online: "good",
  connecting: "neutral",
  reconnecting: "warn",
  offline: "warn",
  unconfigured: "neutral"
};

const PR_SWITCHES: SwitchKey[] = ["allowMergeCommit", "allowSquashMerge", "allowRebaseMerge", "allowAutoMerge", "allowUpdateBranch", "deleteBranchOnMerge"];
const FEATURE_SWITCHES: SwitchKey[] = ["hasIssues", "hasWiki", "hasProjects", "hasDiscussions"];

export function RepoSettingsPage() {
  const { t } = useT();
  const hub = usePullRequestHub();
  const selection = useRepoSelection(hub.repos);
  const { route, selected } = selection;
  const settings = useRepoSettings(hub.askGitHub, route, selected?.github, hub.status === "online");

  return (
    <section>
      <PageHeader
        title={t("repoSettings.title")}
        subtitle={t("repoSettings.subtitle")}
        actions={
          <>
            <StatusPill tone={hubTone[hub.status]}>{t(`runners.hub.${hub.status}`)}</StatusPill>
            <ActionButton
              variant="icon"
              onClick={() => (hub.status === "offline" ? hub.retry() : void settings.refetch())}
              title={t("common.refresh")}
              icon={<RefreshCw size={18} />}
            />
          </>
        }
      />

      {hub.status === "unconfigured" ? (
        <EmptyState icon={<Settings2 size={22} />} title={t("runners.unconfigured.title")} description={t("runners.unconfigured.body")} />
      ) : hub.status === "offline" ? (
        <ErrorState message={hub.error || t("runners.offline")} onRetry={hub.retry} />
      ) : hub.status === "connecting" ? (
        <div className="panel">
          <Skeleton className="skeleton-line" />
          <Skeleton className="skeleton-line" />
        </div>
      ) : !selected || !route ? (
        <EmptyState icon={<Settings2 size={22} />} title={t("prs.noRepos.title")} description={t("prs.noRepos.body")} />
      ) : (
        <>
          <RepoPicker repos={hub.repos} {...selection} selected={selected} route={route} />
          {settings.isError ? (
            <ErrorState message={settings.error.message} onRetry={() => void settings.refetch()} />
          ) : settings.isPending ? (
            <div className="panel">
              <Skeleton className="skeleton-line-lg" />
              <Skeleton className="skeleton-line" />
              <Skeleton className="skeleton-line" />
            </div>
          ) : (
            // Keyed so switching repos starts a fresh form instead of carrying edits across.
            <SettingsForm key={`${route.runnerId}:${selected.github}`} askGitHub={hub.askGitHub} route={route} saved={settings.data} />
          )}
        </>
      )}
    </section>
  );
}

type Draft = Pick<RepoSettings, "description" | "homepage" | "defaultBranch" | SwitchKey> & { topics: string };

function toDraft(settings: RepoSettings): Draft {
  const { description, homepage, defaultBranch } = settings;
  const switches = Object.fromEntries([...PR_SWITCHES, ...FEATURE_SWITCHES].map((key) => [key, settings[key]])) as Pick<RepoSettings, SwitchKey>;
  return { description, homepage, defaultBranch, ...switches, topics: settings.topics.join(", ") };
}

function parseTopics(text: string) {
  return [...new Set(text.split(/[,\s]+/).map((topic) => topic.trim().toLowerCase()).filter(Boolean))];
}

// Only what differs from the saved settings goes to the runner.
function diff(saved: RepoSettings, draft: Draft): SettingsChanges {
  const changes: SettingsChanges = {};
  for (const key of ["description", "homepage", "defaultBranch"] as const) if (draft[key] !== saved[key]) changes[key] = draft[key];
  for (const key of [...PR_SWITCHES, ...FEATURE_SWITCHES]) {
    const value = draft[key];
    if (value !== null && value !== saved[key]) (changes as Record<string, boolean>)[key] = value;
  }
  const topics = parseTopics(draft.topics);
  const addTopics = topics.filter((topic) => !saved.topics.includes(topic));
  const removeTopics = saved.topics.filter((topic) => !topics.includes(topic));
  if (addTopics.length) changes.addTopics = addTopics;
  if (removeTopics.length) changes.removeTopics = removeTopics;
  return changes;
}

function SettingsForm({
  askGitHub,
  route,
  saved
}: { askGitHub: ReturnType<typeof usePullRequestHub>["askGitHub"]; route: PullRequestRoute; saved: RepoSettings }) {
  const { t } = useT();
  const save = useSaveRepoSettings(askGitHub, route, saved.name);
  const [draft, setDraft] = useState(() => toDraft(saved));
  const [justSaved, setJustSaved] = useState(false);

  // A refresh or a save brings new saved settings; the form follows them.
  useEffect(() => setDraft(toDraft(saved)), [saved]);

  const changes = useMemo(() => diff(saved, draft), [saved, draft]);
  const dirty = Object.keys(changes).length > 0;
  const readOnly = !saved.canAdminister || saved.archived;
  const noMergeMethod = draft.allowMergeCommit === false && draft.allowSquashMerge === false && draft.allowRebaseMerge === false;
  const badTopic = parseTopics(draft.topics).find((topic) => !/^[a-z0-9][a-z0-9-]{0,49}$/.test(topic));

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setJustSaved(false);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  function submit() {
    save.mutate(changes, { onSuccess: () => setJustSaved(true) });
  }

  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="panel settings-repo">
        <a href={saved.url} target="_blank" rel="noreferrer" className="pr-title">
          {saved.name} <ExternalLink size={14} />
        </a>
        <div className="chips">
          <StatusPill tone="neutral">{t(`repoSettings.visibility.${saved.visibility}` as TranslationKey, saved.visibility)}</StatusPill>
          {saved.archived ? <StatusPill tone="warn">{t("repoSettings.archived")}</StatusPill> : null}
        </div>
        <span className="muted">{fill(t("prs.identity"), { account: route.githubAccount ?? "?", runner: route.runnerName })}</span>
      </div>

      {saved.archived ? (
        <Alert tone="warn">{t("repoSettings.archivedNote")}</Alert>
      ) : !saved.canAdminister ? (
        <Alert tone="warn">{fill(t("repoSettings.readOnly"), { account: route.githubAccount ?? "?" })}</Alert>
      ) : null}

      <fieldset className="panel settings-section" disabled={readOnly || save.isPending}>
        <h3>{t("repoSettings.general")}</h3>
        <label className="form-field">
          <span>{t("repoSettings.description")}</span>
          <input value={draft.description} onChange={(event) => set("description", event.target.value)} maxLength={350} />
        </label>
        <label className="form-field">
          <span>{t("repoSettings.homepage")}</span>
          <input type="url" value={draft.homepage} onChange={(event) => set("homepage", event.target.value)} placeholder="https://" />
        </label>
        <label className="form-field">
          <span>{t("repoSettings.defaultBranch")}</span>
          <select value={draft.defaultBranch} onChange={(event) => set("defaultBranch", event.target.value)}>
            {saved.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
          </select>
        </label>
        {changes.defaultBranch ? <Alert tone="warn">{t("repoSettings.defaultBranchNote")}</Alert> : null}
        <label className="form-field">
          <span>{t("repoSettings.topics")}</span>
          <input value={draft.topics} onChange={(event) => set("topics", event.target.value)} placeholder={t("repoSettings.topicsPlaceholder")} />
        </label>
        {badTopic ? <Alert tone="error">{fill(t("repoSettings.badTopic"), { topic: badTopic })}</Alert> : null}
      </fieldset>

      <fieldset className="panel settings-section" disabled={readOnly || save.isPending}>
        <h3>{t("repoSettings.pullRequests")}</h3>
        {PR_SWITCHES.map((key) => <Switch key={key} name={key} value={draft[key]} onChange={(value) => set(key, value)} />)}
        {noMergeMethod ? <Alert tone="error">{t("repoSettings.noMergeMethod")}</Alert> : null}
      </fieldset>

      <fieldset className="panel settings-section" disabled={readOnly || save.isPending}>
        <h3>{t("repoSettings.features")}</h3>
        {FEATURE_SWITCHES.map((key) => <Switch key={key} name={key} value={draft[key]} onChange={(value) => set(key, value)} />)}
      </fieldset>

      {save.isError ? <Alert tone="error">{save.error.message}</Alert> : null}
      {justSaved && !dirty ? <Alert tone="info">{t("repoSettings.saved")}</Alert> : null}

      {readOnly ? null : (
        <div className="form-actions settings-actions">
          <button type="button" className="icon-button" disabled={!dirty || save.isPending} onClick={() => setDraft(toDraft(saved))}>
            <RotateCcw size={16} /> {t("repoSettings.reset")}
          </button>
          <button type="submit" className="primary-button" disabled={!dirty || save.isPending || noMergeMethod || Boolean(badTopic)}>
            <Save size={16} /> {save.isPending ? t("prs.working") : t("common.save")}
          </button>
        </div>
      )}
    </form>
  );
}

function Switch({ name, onChange, value }: { name: SwitchKey; onChange: (value: boolean) => void; value: boolean | null }) {
  const { t } = useT();
  return (
    <label className="settings-switch">
      <input type="checkbox" checked={value ?? false} disabled={value === null} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>{t(`repoSettings.${name}` as TranslationKey)}</strong>
        <span className="muted">{value === null ? t("repoSettings.hidden") : t(`repoSettings.${name}.hint` as TranslationKey)}</span>
      </span>
    </label>
  );
}

// t() has no parameters, so translated strings carry {name} placeholders filled here.
function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
