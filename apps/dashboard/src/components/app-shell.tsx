import { SidebarProvider, SidebarInset, SidebarTrigger, useSidebar } from "@solcreek/ui/components/sidebar";
import { Separator } from "@solcreek/ui/components/separator";
import { AppSidebar } from "./app-sidebar";
import { ProjectSwitcher } from "./project-switcher";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <Header />
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function Header() {
  const { open } = useSidebar();

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
      {!open && (
        <>
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
        </>
      )}
      <ProjectSwitcher />
    </header>
  );
}
