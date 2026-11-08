import {
  ArrowDown,
  ArrowUp,
  Download,
  Folder,
  Magnet,
  Pause,
  PanelLeft,
  Play,
  Plus,
  Repeat,
  Scissors,
  Search,
  Loader2,
  Trash2,
  TrendingUp,
  AudioLines,
  Flag,
  X,
  ZoomIn,
  ZoomOut,
  type LucideProps,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* Every icon in the app is a lucide icon at a 16px default. The names are kept
 * from the previous hand-drawn set so call sites don't change. */

const sized = (Icon: React.ComponentType<LucideProps>, filled = false) =>
  function SizedIcon({ className, ...props }: LucideProps) {
    return (
      <Icon
        size={16}
        strokeWidth={1.75}
        className={cn(filled && "fill-current", className)}
        {...props}
      />
    );
  };

export const PlayIcon = sized(Play, true);
export const PauseIcon = sized(Pause, true);
export const SearchIcon = sized(Search);
export const FolderIcon = sized(Folder);
export const DownloadIcon = sized(Download);
export const TrashIcon = sized(Trash2);
export const XIcon = sized(X);
export const ArrowUpIcon = sized(ArrowUp);
export const ArrowDownIcon = sized(ArrowDown);
export const PlusIcon = sized(Plus);
export const WaveIcon = sized(AudioLines);
export const ScissorsIcon = sized(Scissors);
export const MagnetIcon = sized(Magnet);
export const LoopIcon = sized(Repeat);
export const MarkerIcon = sized(Flag);
export const ZoomInIcon = sized(ZoomIn);
export const ZoomOutIcon = sized(ZoomOut);
export const FadeIcon = sized(TrendingUp);
export const SidebarIcon = sized(PanelLeft);

const Spin = sized(Loader2);
export const SpinnerIcon = ({ className, ...props }: LucideProps) => (
  <Spin className={cn("animate-spin", className)} {...props} />
);
