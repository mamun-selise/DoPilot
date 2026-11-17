import { PullRequestsView } from "../pullRequests/PullRequestsPage";
import { QuickDeploy } from "./QuickDeploy";

// Release > Deploy to stage / Deploy to prod: the deployment (yml) repository's PRs for that environment, told
// apart by title, with Approve and Merge, under Quick deploy (every service at its newest version, one button).
export function DeployToStagePage() {
  return <PullRequestsView variant="stage" top={(context) => <QuickDeploy env="stg" {...context} />} />;
}

export function DeployToProdPage() {
  return <PullRequestsView variant="prod" top={(context) => <QuickDeploy env="production" {...context} />} />;
}
