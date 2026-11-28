import { useEffect } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@solcreek/ui/components/sidebar";
import {
  Menu,
  MenuPopup,
  MenuGroup,
  MenuItem,
  MenuGroupLabel,
  MenuSeparator,
  MenuTrigger,
} from "@solcreek/ui/components/menu";
import {
  Folder,
  Database,
  HardDrive,
  Archive,
  Sparkles,
  Rocket,
  Settings,
  Key,
  Server,
  ChevronsUpDown,
  LogOut,
  Plus,
  Check,
} from "lucide-react";
import { authClient, useSession, useActiveOrganization, useCurrentTeam } from "@/lib/auth";
import { useFeatures, useApiMode } from "@/lib/api-context";

const PLATFORM_ITEMS = [{ to: "/projects" as const, label: "Projects", icon: Folder }];

const SETTINGS_ITEMS = [
  { to: "/settings" as const, label: "Settings", icon: Settings },
  { to: "/api-keys" as const, label: "API Keys", icon: Key },
];

const RESOURCE_ITEMS = [
  { to: "/resources/database" as const, label: "Database", icon: Database },
  { to: "/resources/storage" as const, label: "Storage", icon: HardDrive },
  { to: "/resources/cache" as const, label: "Cache", icon: Archive },
  { to: "/resources/ai" as const, label: "AI", icon: Sparkles },
];

export function AppSidebar() {
  const mode = useApiMode();
  const features = useFeatures();
  const location = useLocation();
  const { setOpenMobile } = useSidebar();

  // On mobile the sidebar is a sheet over the page: close it once a link
  // has navigated, or it keeps covering the page the user just picked.
  useEffect(() => {
    setOpenMobile(false);
  }, [location.pathname, setOpenMobile]);

  // Tapping the page already shown does not change the pathname, so the
  // effect above never fires: close on any nav-link click as well.
  const closeOnLinkClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("a")) setOpenMobile(false);
  };

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {features.teams ? <TeamSwitcher /> : <CreekdBranding />}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent onClick={closeOnLinkClick}>
        <SidebarGroup>
          <SidebarGroupLabel>{mode === "creekd" ? "Apps" : "Platform"}</SidebarGroupLabel>
          <SidebarMenu>
            {PLATFORM_ITEMS.map((item) => {
              const isActive = location.pathname.startsWith(item.to);
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton isActive={isActive} render={<Link to={item.to} />}>
                    <item.icon />
                    <span>{mode === "creekd" ? "Apps" : item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        {features.resources && (
          <SidebarGroup>
            <SidebarGroupLabel>Resources</SidebarGroupLabel>
            <SidebarMenu>
              <ResourcesNav pathname={location.pathname} />
            </SidebarMenu>
          </SidebarGroup>
        )}

        {features.auth && (
          <SidebarGroup>
            <SidebarGroupLabel>Account</SidebarGroupLabel>
            <SidebarMenu>
              {SETTINGS_ITEMS.map((item) => {
                if (item.to === "/api-keys" && !features.apiKeys) return null;
                const isActive = location.pathname.startsWith(item.to);
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton isActive={isActive} render={<Link to={item.to} />}>
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>

      {features.auth && <UserFooter />}

      <SidebarRail />
    </Sidebar>
  );
}

function UserFooter() {
  const { data: session } = useSession();
  const user = session?.user;
  const initials =
    user?.name
      ?.split(" ")
      .map((n) => n[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() ?? "?";

  return (
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <Menu>
            <MenuTrigger
              render={
                <SidebarMenuButton size="lg">
                  <div className="flex size-8 items-center justify-center rounded-lg bg-secondary text-xs font-semibold">
                    {initials}
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">{user?.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{user?.email}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              }
            />
            <MenuPopup className="min-w-56" side="top" align="start">
              <MenuGroup>
                <MenuGroupLabel>
                  <div className="flex items-center gap-2 py-1">
                    <div className="flex size-8 items-center justify-center rounded-lg bg-secondary text-xs font-semibold">
                      {initials}
                    </div>
                    <div className="grid text-left text-sm leading-tight">
                      <span className="truncate font-semibold">{user?.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{user?.email}</span>
                    </div>
                  </div>
                </MenuGroupLabel>
              </MenuGroup>
              <MenuSeparator />
              <MenuGroup>
                <MenuItem render={<Link to="/settings" />}>
                  <Settings className="mr-2 size-4" />
                  Settings
                </MenuItem>
                <MenuItem render={<Link to="/api-keys" />}>
                  <Key className="mr-2 size-4" />
                  API Keys
                </MenuItem>
              </MenuGroup>
              <MenuSeparator />
              <MenuItem onClick={() => authClient.signOut()}>
                <LogOut className="mr-2 size-4" />
                Sign out
              </MenuItem>
            </MenuPopup>
          </Menu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

function CreekdBranding() {
  return (
    <SidebarMenuButton size="lg">
      <div className="flex size-8 items-center justify-center rounded-lg bg-brand/20 text-brand">
        <Server className="size-4" />
      </div>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-semibold">creek</span>
        <span className="truncate text-xs text-muted-foreground">self-hosted</span>
      </div>
    </SidebarMenuButton>
  );
}

function ResourcesNav({ pathname }: { pathname: string }) {
  return (
    <>
      {RESOURCE_ITEMS.map((item) => {
        const isActive = pathname === item.to || pathname.startsWith(item.to + "/");
        return (
          <SidebarMenuItem key={item.to}>
            <SidebarMenuButton isActive={isActive} render={<Link to={item.to} />}>
              <item.icon />
              <span>{item.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </>
  );
}

function TeamSwitcher() {
  const { data: activeOrg } = useActiveOrganization();
  const { data: orgs } = authClient.useListOrganizations();
  const orgList = (orgs as any[]) ?? [];
  const { team: displayOrg } = useCurrentTeam();

  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarMenuButton size="lg">
            <div className="flex size-8 items-center justify-center rounded-lg bg-brand/20 text-brand">
              <Rocket className="size-4" />
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-semibold">{displayOrg?.name ?? "Select team"}</span>
              <span className="truncate text-xs text-muted-foreground">
                {displayOrg?.slug ?? ""}
              </span>
            </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </SidebarMenuButton>
        }
      />
      <MenuPopup className="min-w-56" align="start">
        <MenuGroup>
          <MenuGroupLabel>Teams</MenuGroupLabel>
          {orgList.map((org: any) => (
            <MenuItem
              key={org.id}
              onClick={() => authClient.organization.setActive({ organizationId: org.id })}
            >
              <Rocket className="mr-2 size-4" />
              <span>{org.name}</span>
              {org.id === activeOrg?.id && <Check className="ml-auto size-4" />}
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem>
          <Plus className="mr-2 size-4" />
          Create team
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
