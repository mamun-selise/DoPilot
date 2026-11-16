import { Cloud, FolderGit2, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import { Alert } from "../../shared/ui/Alert";
import { Modal } from "../../shared/ui/Modal";
import type { PullRequestRepo, PullRequestRoute, usePullRequestHub } from "./usePullRequests";

type Hub = ReturnType<typeof usePullRequestHub>;

// Shared by the PRs and Repo settings pages, so both open on the same repository.
const REPO_KEY = "blocks-app:prs-repo";

// Keeps the selection valid as runners come and go: falls back to the first repo, and to the first runner for
// it (the user's own runner comes first).
export function useRepoSelection(repos: PullRequestRepo[]) {
  const [repo, setRepo] = useState(() => localStorage.getItem(REPO_KEY) ?? "");
  const [runnerId, setRunnerId] = useState("");

  const selected = repos.find((entry) => entry.github.toLowerCase() === repo.toLowerCase()) ?? repos[0];
  const route = selected?.runners.find((entry) => entry.runnerId === runnerId) ?? selected?.runners[0];

  useEffect(() => {
    if (selected) localStorage.setItem(REPO_KEY, selected.github);
  }, [selected?.github]);

  const selectRepo = (github: string) => {
    setRepo(github);
    setRunnerId("");
  };

  return { selected, route, selectRepo, selectRunner: setRunnerId };
}

type Selection = ReturnType<typeof useRepoSelection>;

export function RepoPicker({
  hub,
  route,
  selected,
  selectRepo,
  selectRunner
}: { hub: Hub } & Selection & { selected: PullRequestRepo; route: PullRequestRoute }) {
  const { t } = useT();
  const [removing, setRemoving] = useState(false);
  // A GitHub-only repository on one of the user's own runners can be removed from here; clones live in runner.yml.
  const removable = !route.local && hub.ownRunners.some((own) => own.runnerId === route.runnerId);

  return (
    <div className="repo-picker">
      <div className="filter-grid prs-toolbar">
        <label className="form-field">
          <span>{t("prs.repository")}</span>
          <select value={selected.github} onChange={(event) => selectRepo(event.target.value)}>
            {hub.repos.map((entry) => <option key={entry.github} value={entry.github}>{entry.github}</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>{t("prs.via")}</span>
          <select value={route.runnerId} onChange={(event) => selectRunner(event.target.value)} disabled={selected.runners.length < 2}>
            {selected.runners.map((entry) => <option key={entry.runnerId} value={entry.runnerId}>{routeLabel(entry)}</option>)}
          </select>
        </label>
      </div>
      <div className="repo-picker-actions">
        <AddRepositoryButton hub={hub} onAdded={selectRepo} />
        {removable ? (
          <button className="icon-button" onClick={() => setRemoving(true)} title={t("repos.remove")}>
            <Trash2 size={16} /> {t("repos.remove")}
          </button>
        ) : null}
        {!route.local ? <span className="chip">{t("repos.githubOnly")}</span> : null}
      </div>
      {removing ? <RemoveRepositoryDialog hub={hub} repo={selected.github} route={route} onClose={() => setRemoving(false)} /> : null}
    </div>
  );
}

export function AddRepositoryButton({ hub, onAdded }: { hub: Hub; onAdded: (github: string) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-button" onClick={() => setOpen(true)}>
        <Plus size={16} /> {t("repos.add")}
      </button>
      {open ? <AddRepositoryDialog hub={hub} onAdded={onAdded} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

// Accepts owner/name or a pasted GitHub URL (https://github.com/owner/name(.git), git@github.com:owner/name.git).
function parseRepo(text: string) {
  const trimmed = text.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const match = trimmed.match(/github\.com[:/]([^/\s]+\/[^/\s]+)$/) ?? trimmed.match(/^([\w.-]+\/[\w.-]+)$/);
  return match?.[1] ?? null;
}

type Candidate = { path: string; github: string | null };

function AddRepositoryDialog({ hub, onAdded, onClose }: { hub: Hub; onAdded: (github: string) => void; onClose: () => void }) {
  const { t } = useT();
  const [source, setSource] = useState<"local" | "github">("local");
  const [text, setText] = useState("");
  const [path, setPath] = useState("");
  const [key, setKey] = useState("");
  const [runnerId, setRunnerId] = useState(hub.ownRunners[0]?.runnerId ?? "");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const repo = parseRepo(text);
  const runner = hub.ownRunners.find((entry) => entry.runnerId === runnerId) ?? hub.ownRunners[0];
  const picked = candidates?.find((candidate) => candidate.path === path);

  // The runner suggests git folders near its clones; asked again when another runner is picked.
  useEffect(() => {
    if (source !== "local" || !runner) return;
    let cancelled = false;
    setCandidates(null);
    hub
      .askGitHub("LocalRepositoryCandidates", runner.runnerId)
      .then((answer) => !cancelled && setCandidates((answer.candidates as Candidate[] | undefined) ?? []))
      .catch(() => !cancelled && setCandidates([]));
    return () => {
      cancelled = true;
    };
  }, [source, runner?.runnerId]);

  async function add() {
    if (!runner) return;
    setBusy(true);
    setError(null);
    try {
      const answer =
        source === "local"
          ? await hub.askGitHub("AddLocalRepository", runner.runnerId, path, key || null)
          : await hub.askGitHub("AddRepository", runner.runnerId, repo);
      if (answer.github) onAdded(String(answer.github));
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("repos.add.title")} onClose={onClose}>
      {hub.ownRunners.length === 0 ? (
        <Alert tone="warn">{t("repos.add.noRunner")}</Alert>
      ) : (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="segmented" role="tablist">
            <button type="button" role="tab" aria-selected={source === "local"} className={source === "local" ? "active" : ""} onClick={() => setSource("local")}>
              <FolderGit2 size={15} /> {t("repos.add.local")}
            </button>
            <button type="button" role="tab" aria-selected={source === "github"} className={source === "github" ? "active" : ""} onClick={() => setSource("github")}>
              <Cloud size={15} /> {t("repos.add.githubOnly")}
            </button>
          </div>

          <label className="form-field">
            <span>{t("repos.add.runner")}</span>
            <select value={runner?.runnerId} onChange={(event) => setRunnerId(event.target.value)}>
              {hub.ownRunners.map((entry) => (
                <option key={entry.runnerId} value={entry.runnerId}>
                  {entry.runnerName}{entry.githubAccount ? ` (gh ${entry.githubAccount})` : ""}
                </option>
              ))}
            </select>
          </label>

          {source === "local" ? (
            <>
              <p>{t("repos.add.localBody")}</p>
              <div className="form-field">
                <span>{t("repos.add.found")}</span>
                <div className="candidate-list">
                  {candidates === null ? (
                    <span className="muted">{t("repos.add.scanning")}</span>
                  ) : candidates.length === 0 ? (
                    <span className="muted">{t("repos.add.noneFound")}</span>
                  ) : (
                    candidates.map((candidate) => (
                      <button
                        type="button"
                        key={candidate.path}
                        className={`candidate${candidate.path === path ? " active" : ""}`}
                        onClick={() => setPath(candidate.path)}
                      >
                        <strong className="mono-sm">{candidate.path}</strong>
                        <span className="muted">{candidate.github ?? t("runners.repo.noRemote")}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
              <label className="form-field">
                <span>{t("repos.add.path")}</span>
                <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="D:\code\my-fe" />
              </label>
              <label className="form-field">
                <span>{t("repos.add.key")}</span>
                <input value={key} onChange={(event) => setKey(event.target.value.toLowerCase())} placeholder={t("repos.add.keyPlaceholder")} />
              </label>
              {picked && !picked.github ? <Alert tone="info">{t("repos.add.noRemoteNote")}</Alert> : null}
            </>
          ) : (
            <>
              <p>{t("repos.add.body")}</p>
              <label className="form-field">
                <span>{t("repos.add.repo")}</span>
                <input autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder="owner/name" />
              </label>
              {text && !repo ? <Alert tone="error">{t("repos.add.invalid")}</Alert> : null}
            </>
          )}

          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="modal-actions">
            <button type="button" className="icon-button" onClick={onClose}>{t("common.cancel")}</button>
            <button type="submit" className="primary-button" disabled={busy || (source === "local" ? !path.trim() : !repo)}>
              <Plus size={16} /> {busy ? t("prs.working") : t("repos.add")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function RemoveRepositoryDialog({ hub, onClose, repo, route }: { hub: Hub; onClose: () => void; repo: string; route: PullRequestRoute }) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await hub.askGitHub("RemoveRepository", route.runnerId, repo);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  }

  return (
    <Modal title={t("repos.remove.title")} onClose={onClose}>
      <p>{fill(t("repos.remove.body"), { repo, runner: route.runnerName })}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="modal-actions">
        <button className="icon-button" onClick={onClose}>{t("common.cancel")}</button>
        <button className="primary-button danger" disabled={busy} onClick={() => void remove()}>
          <Trash2 size={16} /> {busy ? t("prs.working") : t("repos.remove")}
        </button>
      </div>
    </Modal>
  );
}

function routeLabel(route: PullRequestRoute) {
  const owner = route.owner.name || route.owner.email || route.owner.sub;
  return `${route.runnerName} (${owner}${route.githubAccount ? ` · gh ${route.githubAccount}` : ""})`;
}

// t() has no parameters, so translated strings carry {name} placeholders filled here.
function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
