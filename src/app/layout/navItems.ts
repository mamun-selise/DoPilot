import { GitPullRequest, Server, Settings2, UserRound } from "lucide-react";

export const navItems = [
  { href: "/", labelKey: "nav.profile", icon: UserRound },
  { href: "/runners", labelKey: "nav.runners", icon: Server },
  { href: "/prs", labelKey: "nav.prs", icon: GitPullRequest },
  { href: "/repo-settings", labelKey: "nav.repoSettings", icon: Settings2 }
] as const;
