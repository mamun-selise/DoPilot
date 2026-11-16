import { Activity, ChevronDown, ChevronRight, PanelLeft } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { findNav, isGroup, navItems, type NavLink } from "./navItems";
import { NotificationsMenu } from "./NotificationsMenu";
import { UserMenu } from "./UserMenu";
import { useT } from "../../lib/i18n/LocalizationProvider";

const COLLAPSED_KEY = "blocks-app:sidebar-collapsed";
const CLOSED_GROUPS_KEY = "blocks-app:nav-closed-groups";
const MOBILE_QUERY = "(max-width: 880px)";

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

export function AppShell({ activePath, children, onNavigate }: { activePath: string; children: ReactNode; onNavigate: (path: string) => void }) {
  const isMobile = useIsMobile();
  const [collapsedPref, setCollapsedPref] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "true");
  const { t } = useT();
  // On narrow screens the sidebar is always the icon-only rail below --
  // no separate hamburger/drawer/scrim needed, and no dead-end state where
  // nothing on screen can bring navigation back.
  const collapsed = collapsedPref || isMobile;
  const active = findNav(activePath);
  // Groups are open unless the user closed them; the group holding the current page always shows its links.
  const [closedGroups, setClosedGroups] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(CLOSED_GROUPS_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const toggleGroup = (id: string) =>
    setClosedGroups((current) => {
      const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
      localStorage.setItem(CLOSED_GROUPS_KEY, JSON.stringify(next));
      return next;
    });

  const renderLink = (item: NavLink, sub = false) => (
    <a
      key={item.href}
      href={item.href}
      data-tooltip={t(item.labelKey)}
      className={[activePath === item.href ? "active" : "", sub ? "sub" : ""].join(" ").trim()}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(item.href);
      }}
    >
      <item.icon size={sub ? 16 : 18} />
      {collapsed ? null : <span>{t(item.labelKey)}</span>}
    </a>
  );

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsedPref));
  }, [collapsedPref]);

  return (
    <div className="shell">
      <aside className={collapsed ? "collapsed" : ""}>
        <div className="sidebar-header">
          {collapsed ? null : (
            <a className="brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("/"); }}>
              <span className="brand-mark"><Activity size={16} /></span>
              <span className="brand-text">
                <span>{t("app.short")}</span>
                <small>{t("app.tagline")}</small>
              </span>
            </a>
          )}
          {/* Hidden on mobile by CSS (nothing to toggle -- the rail is always
             collapsed there); on desktop it's the only control that can
             re-expand the sidebar, so it must never be the thing collapsing hides. */}
          <button className="icon-button sidebar-collapse-toggle" onClick={() => setCollapsedPref((value) => !value)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            <PanelLeft size={16} />
          </button>
        </div>
        <nav>
          {navItems.map((item) => {
            if (!isGroup(item)) return renderLink(item);
            // The icon-only rail has no room for headings: it shows the group's links, set off by a divider.
            if (collapsed) return <div className="nav-group-rail" key={item.id}>{item.children.map((child) => renderLink(child))}</div>;
            const open = !closedGroups.includes(item.id) || active?.group === item;
            return (
              <div className="nav-group" key={item.id}>
                <button className={`nav-group-heading${active?.group === item ? " has-active" : ""}`} onClick={() => toggleGroup(item.id)} aria-expanded={open}>
                  <item.icon size={18} />
                  <span>{t(item.labelKey)}</span>
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                {open ? item.children.map((child) => renderLink(child, true)) : null}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="content">
        <header className="topbar">
          {active ? (
            <div className="breadcrumb">
              <active.link.icon size={16} />
              {active.group ? <span className="breadcrumb-parent">{t(active.group.labelKey)} /</span> : null}
              <span>{t(active.link.labelKey)}</span>
            </div>
          ) : null}
          <div className="topbar-spacer" />
          <LanguageSwitcher />
          <NotificationsMenu />
          <UserMenu onNavigate={onNavigate} />
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
