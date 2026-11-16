import { CloudUpload, GitPullRequest, Layers, Rocket, Server, Settings2, ShieldCheck, UserRound, type LucideIcon } from "lucide-react";
import type { TranslationKey } from "../../lib/i18n/dictionary";

export type NavLink = { href: string; labelKey: TranslationKey; icon: LucideIcon };
// A group is a heading with sub-menu links under it; add more release pages to Release's children.
export type NavGroup = { id: string; labelKey: TranslationKey; icon: LucideIcon; children: NavLink[] };

export const navItems: (NavLink | NavGroup)[] = [
  { href: "/", labelKey: "nav.profile", icon: UserRound },
  { href: "/runners", labelKey: "nav.runners", icon: Server },
  { href: "/prs", labelKey: "nav.prs", icon: GitPullRequest },
  { href: "/repo-settings", labelKey: "nav.repoSettings", icon: Settings2 },
  {
    id: "release",
    labelKey: "nav.release",
    icon: Rocket,
    children: [
      { href: "/release/stage", labelKey: "nav.release.stage", icon: Layers },
      { href: "/release/deploy-stage", labelKey: "nav.release.deployStage", icon: CloudUpload },
      { href: "/release/deploy-prod", labelKey: "nav.release.deployProd", icon: ShieldCheck }
    ]
  }
];

export const isGroup = (item: NavLink | NavGroup): item is NavGroup => "children" in item;

/** The page at a path, and the group it sits in (for the breadcrumb). */
export function findNav(path: string): { link: NavLink; group?: NavGroup } | undefined {
  for (const item of navItems) {
    if (!isGroup(item)) {
      if (item.href === path) return { link: item };
      continue;
    }
    const link = item.children.find((child) => child.href === path);
    if (link) return { link, group: item };
  }
  return undefined;
}
