import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n/LocalizationProvider";
import type { PullRequestRepo, PullRequestRoute } from "./usePullRequests";

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

export function RepoPicker({
  repos,
  route,
  selected,
  selectRepo,
  selectRunner
}: { repos: PullRequestRepo[] } & ReturnType<typeof useRepoSelection> & { selected: PullRequestRepo; route: PullRequestRoute }) {
  const { t } = useT();
  return (
    <div className="filter-grid prs-toolbar">
      <label className="form-field">
        <span>{t("prs.repository")}</span>
        <select value={selected.github} onChange={(event) => selectRepo(event.target.value)}>
          {repos.map((entry) => <option key={entry.github} value={entry.github}>{entry.github}</option>)}
        </select>
      </label>
      <label className="form-field">
        <span>{t("prs.via")}</span>
        <select value={route.runnerId} onChange={(event) => selectRunner(event.target.value)} disabled={selected.runners.length < 2}>
          {selected.runners.map((entry) => <option key={entry.runnerId} value={entry.runnerId}>{routeLabel(entry)}</option>)}
        </select>
      </label>
    </div>
  );
}

function routeLabel(route: PullRequestRoute) {
  const owner = route.owner.name || route.owner.email || route.owner.sub;
  return `${route.runnerName} (${owner}${route.githubAccount ? ` · gh ${route.githubAccount}` : ""})`;
}
