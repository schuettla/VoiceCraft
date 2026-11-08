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
import { SystemResources } from "@/components/SystemResources";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
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
      <SidebarHeader className="h-12 justify-center border-b px-4">
        <span className="text-[15px] font-semibold tracking-tight text-white group-data-[collapsible=icon]:hidden">
          Voice<span className="text-primary">Craft</span>
        </span>
        <span className="hidden text-sm font-semibold text-primary group-data-[collapsible=icon]:block">
          V
        </span>
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
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="gap-0 p-0">
        {isTauri() && (
          <SidebarMenu className="p-2">
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Re-run engine setup" onClick={onRunSetup}>
                <Wrench />
                <span>Engine setup</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
        <SystemResources />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
