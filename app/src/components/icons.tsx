import type { SVGProps } from "react";

/* Minimal single-colour line icons — currentColor, 1.5px stroke, 16px grid.
 * Kept in one place so every row and button draws from the same set. */

type P = SVGProps<SVGSVGElement>;

function Svg(props: P) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

export const PlayIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 3.5v9l7.5-4.5L5 3.5Z" fill="currentColor" stroke="none" />
  </Svg>
);

export const PauseIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4.5" y="3.5" width="2.5" height="9" rx="0.5" fill="currentColor" stroke="none" />
    <rect x="9" y="3.5" width="2.5" height="9" rx="0.5" fill="currentColor" stroke="none" />
  </Svg>
);

export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4" />
    <path d="m13 13-3-3" />
  </Svg>
);

export const FolderIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.6h4.8A1.5 1.5 0 0 1 14 6.1V11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11V4.5Z" />
  </Svg>
);

export const DownloadIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.5v7m0 0L5.2 6.8M8 9.5l2.8-2.7M3 12.5h10" />
  </Svg>
);

export const TrashIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.5h10M6.5 4V3h3v1M4.5 4.5 5 13h6l.5-8.5M7 7v3.5M9 7v3.5" />
  </Svg>
);

export const XIcon = (p: P) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);

export const ArrowUpIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
  </Svg>
);

export const ArrowDownIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />
  </Svg>
);

export const PlusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const SpinnerIcon = (p: P) => (
  <Svg {...p} className={["animate-spin", p.className].filter(Boolean).join(" ")}>
    <path d="M8 2a6 6 0 1 0 6 6" />
  </Svg>
);

export const WaveIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2 8h1.5M12.5 8H14M5 4.5v7M8 2.5v11M11 4.5v7" />
  </Svg>
);

export const ScissorsIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="4.5" cy="4.5" r="1.75" />
    <circle cx="4.5" cy="11.5" r="1.75" />
    <path d="m6 5.5 8 6M6 10.5l8-6" />
  </Svg>
);

export const MagnetIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 2.5v5.5a4 4 0 0 0 8 0V2.5" />
    <path d="M4 2.5h3M9 2.5h3M4 5.5h3M9 5.5h3" />
  </Svg>
);

export const LoopIcon = (p: P) => (
  <Svg {...p}>
    <path d="M11.5 5.5H5a2.5 2.5 0 0 0 0 5h.5" />
    <path d="m9.5 3.5 2 2-2 2M6.5 12.5l-2-2 2-2" />
  </Svg>
);

export const MarkerIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 2v12" />
    <path d="M4 2.5h7l-2 2.5 2 2.5H4Z" />
  </Svg>
);

export const ZoomInIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="6.75" cy="6.75" r="4.25" />
    <path d="m13 13-2.7-2.7M6.75 4.75v4M4.75 6.75h4" />
  </Svg>
);

export const ZoomOutIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="6.75" cy="6.75" r="4.25" />
    <path d="m13 13-2.7-2.7M4.75 6.75h4" />
  </Svg>
);

export const FadeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 12.5h11M2.5 12.5 12 3" />
  </Svg>
);

export const SidebarIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="1" />
    <path d="M6.5 2.5v11" />
  </Svg>
);
