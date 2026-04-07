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
} from "@solcreek/ui/components/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@solcreek/ui/components/dropdown-menu";
import {
  Folder,
  Rocket,
  Settings,
  Key,
  ChevronsUpDown,
  LogOut,
  Plus,
  Check,
} from "lucide-react";
import { authClient, useSession, useActiveOrganization } from "@/lib/auth";

const NAV_ITEMS = [
  { to: "/projects" as const, label: "Projects", icon: Folder },
  { to: "/settings" as const, label: "Settings", icon: Settings },
  { to: "/api-keys" as const, label: "API Keys", icon: Key },
];

export function AppSidebar() {
  const { data: session } = useSession();
  const location = useLocation();

  const user = session?.user;
  const initials = user?.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() ?? "?";

  return (
    <Sidebar>
      {/* Team switcher */}
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <TeamSwitcher />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      {/* Navigation */}
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarMenu>
            {NAV_ITEMS.map((item) => {
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
      </SidebarContent>

      {/* User menu */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={
                <SidebarMenuButton size="lg">
                  <div className="flex size-8 items-center justify-center rounded-lg bg-secondary text-xs font-semibold">
                    {initials}
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">{user?.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {user?.email}
                    </span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              } />
              <DropdownMenuContent
                className="min-w-56"
                side="top"
                align="start"
              >
                <DropdownMenuLabel>
                  <div className="flex items-center gap-2 py-1">
                    <div className="flex size-8 items-center justify-center rounded-lg bg-secondary text-xs font-semibold">
                      {initials}
                    </div>
                    <div className="grid text-left text-sm leading-tight">
                      <span className="truncate font-semibold">{user?.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {user?.email}
                      </span>
                    </div>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem render={<Link to="/settings" />}>
                  <Settings className="mr-2 size-4" />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem render={<Link to="/api-keys" />}>
                  <Key className="mr-2 size-4" />
                  API Keys
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => authClient.signOut()}>
                  <LogOut className="mr-2 size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

function TeamSwitcher() {
  const { data: activeOrg } = useActiveOrganization();
  const { data: orgs } = authClient.useListOrganizations();

  const orgList = (orgs as any[]) ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <SidebarMenuButton size="lg">
          <div className="flex size-8 items-center justify-center rounded-lg bg-accent/20 text-accent">
            <Rocket className="size-4" />
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">
              {activeOrg?.name ?? "Select team"}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {activeOrg?.slug ?? ""}
            </span>
          </div>
          <ChevronsUpDown className="ml-auto size-4" />
        </SidebarMenuButton>
      } />
      <DropdownMenuContent className="min-w-56" align="start">
        <DropdownMenuLabel>Teams</DropdownMenuLabel>
        {orgList.map((org: any) => (
          <DropdownMenuItem
            key={org.id}
            onClick={() => authClient.organization.setActive({ organizationId: org.id })}
          >
            <Rocket className="mr-2 size-4" />
            <span>{org.name}</span>
            {org.id === activeOrg?.id && <Check className="ml-auto size-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <Plus className="mr-2 size-4" />
          Create team
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
