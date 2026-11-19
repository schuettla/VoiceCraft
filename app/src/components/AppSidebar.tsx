import {
  AudioLines,
  AudioWaveform,
  Boxes,
  Library,
  Settings,
  UserRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { isTauri } from "@/lib/tauri";
import { TOOLBAR_H } from "@/components/common";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export type View = "profiles" | "generate" | "library" | "edit" | "models" | "settings";

type NavItem = { id: View; label: string; hint: string; icon: LucideIcon };

export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Create",
    items: [
      { id: "generate", label: "Generate", hint: "Voice, music and sound effects", icon: AudioLines },
      { id: "profiles", label: "Profiles", hint: "Voices you can generate with", icon: UserRound },
    ],
  },
  {
    label: "Audio",
    items: [
      { id: "library", label: "Library", hint: "Everything generated, with exports", icon: Library },
      { id: "edit", label: "Editor", hint: "Multitrack waveform editor", icon: AudioWaveform },
    ],
  },
  {
    label: "System",
    items: [
      { id: "models", label: "Models", hint: "Download and choose speech models", icon: Boxes },
      { id: "settings", label: "Settings", hint: "Hardware, defaults, storage", icon: Settings },
    ],
  },
];

export const VIEW_LABEL = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items).map((item) => [item.id, item.label]),
) as Record<View, string>;

export function AppSidebar({
  view,
  onNavigate,
  onRunSetup,
}: {
  view: View;
  onNavigate: (view: View) => void;
  onRunSetup: () => void;
}) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader
        data-tauri-drag-region
        className={cn(
          "flex-row items-center justify-between border-b px-3 py-0",
          TOOLBAR_H,
          "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0",
        )}
      >
        <span className="pointer-events-none pl-1 text-[15px] font-semibold tracking-tight text-white group-data-[collapsible=icon]:hidden">
          Voice<span className="text-primary">Craft</span>
        </span>
        <SidebarTrigger className="text-muted-foreground" />
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={view === item.id}
                      tooltip={item.hint}
                      onClick={() => onNavigate(item.id)}
                      className="data-[active=true]:text-primary"
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
                {/* Re-running setup is a system task, so it lives with Models and Settings. */}
                {group.label === "System" && isTauri() && (
                  <SidebarMenuItem>
                    <SidebarMenuButton tooltip="Re-run engine setup" onClick={onRunSetup}>
                      <Wrench />
                      <span>Engine setup</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  );
}
