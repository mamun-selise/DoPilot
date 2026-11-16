import { useEffect, useState } from "react";
import { AppShell } from "../layout/AppShell";
import { RedirectIfAuthenticated, RequireAuth } from "./guards";
import { CallbackPage } from "../../features/auth/CallbackPage";
import { ErrorPage } from "../../features/auth/ErrorPage";
import { LoginPage } from "../../features/auth/LoginPage";
import { NotFoundPage } from "../../features/auth/NotFoundPage";
import { ProfilePage } from "../../features/profile/ProfilePage";
import { PullRequestsPage } from "../../features/pullRequests/PullRequestsPage";
import { RepoSettingsPage } from "../../features/repoSettings/RepoSettingsPage";
import { ReadyToStagePage } from "../../features/release/ReadyToStagePage";
import { DeployToProdPage, DeployToStagePage } from "../../features/release/DeployPages";
import { EnvironmentsPage } from "../../features/release/EnvironmentsPage";
import { RunnersPage } from "../../features/runners/RunnersPage";

const protectedRoutes = {
  "/": ProfilePage,
  "/runners": RunnersPage,
  "/prs": PullRequestsPage,
  "/repo-settings": RepoSettingsPage,
  "/release/stage": ReadyToStagePage,
  "/release/deploy-stage": DeployToStagePage,
  "/release/deploy-prod": DeployToProdPage,
  "/release/environments": EnvironmentsPage,
  "/error": ErrorPage
};

export function AppRouter() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [search, setSearch] = useState(() => window.location.search);

  useEffect(() => {
    const onPopState = () => {
      setPath(window.location.pathname);
      setSearch(window.location.search);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function navigate(nextPath: string) {
    const [nextPathname = "/", queryString = ""] = nextPath.split("?");
    window.history.pushState({}, "", nextPath);
    setPath(nextPathname);
    setSearch(queryString ? `?${queryString}` : "");
  }

  if (path === "/login/callback") {
    return <CallbackPage onNavigate={navigate} />;
  }

  if (path === "/login") {
    const returnTo = new URLSearchParams(search).get("returnTo") || undefined;
    return (
      <RedirectIfAuthenticated onNavigate={navigate}>
        <LoginPage returnTo={returnTo} />
      </RedirectIfAuthenticated>
    );
  }

  const Page = protectedRoutes[path as keyof typeof protectedRoutes];
  if (!Page) {
    return <NotFoundPage onNavigate={navigate} />;
  }

  return (
    <RequireAuth currentPath={path} onNavigate={navigate}>
      <AppShell activePath={path} onNavigate={navigate}>
        <Page />
      </AppShell>
    </RequireAuth>
  );
}
