import { PullRequestsView } from "../pullRequests/PullRequestsPage";

// Release > Deploy to stage / Deploy to prod: the deployment (yml) repository's PRs for that environment, told
// apart by title, with Approve and Merge.
export function DeployToStagePage() {
  return <PullRequestsView variant="stage" />;
}

export function DeployToProdPage() {
  return <PullRequestsView variant="prod" />;
}
