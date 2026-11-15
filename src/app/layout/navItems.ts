import { Server, UserRound } from "lucide-react";

export const navItems = [
  { href: "/", labelKey: "nav.profile", icon: UserRound },
  { href: "/runners", labelKey: "nav.runners", icon: Server }
] as const;
