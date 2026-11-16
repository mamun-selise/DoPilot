import { GitPullRequest, Server, UserRound } from "lucide-react";

export const navItems = [
  { href: "/", labelKey: "nav.profile", icon: UserRound },
  { href: "/runners", labelKey: "nav.runners", icon: Server },
  { href: "/prs", labelKey: "nav.prs", icon: GitPullRequest }
] as const;
