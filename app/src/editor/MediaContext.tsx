import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "../lib/api";
import type { Asset, Generation, SourceRef } from "../lib/types";
import { truncate } from "../lib/format";
import { useToast } from "../components/Toaster";

/* Every source the editor can put on the timeline: generated voice clips and
 * every stored asset (intro/outro/imported clip/rendered output). This is
 * the same catalog the old form-based Edit page built inline — lifted out so
 * the media bin, the timeline (drag sources), and the intro/outro pickers
 * all read one list. */

export type MediaKind = "voice" | "intro" | "outro" | "clip" | "output";

export type MediaClip = {
  key: string; // "g:<id>" | "a:<id>"
  kind: MediaKind;
  title: string;
  path: string;
  duration: number | null;
  ref: SourceRef;
  assetId?: string;
};

export function decodeKey(key: string): SourceRef {
  const id = key.slice(2);
  return key.startsWith("g:") ? { generation_id: id } : { asset_id: id };
}

export const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
  voice: "voice",
  intro: "intro",
  outro: "outro",
  clip: "clip",
  output: "output",
};

type MediaContextValue = {
  clips: MediaClip[];
  byKey: Map<string, MediaClip>;
  intros: Asset[];
  outros: Asset[];
  loading: boolean;
  refresh: () => Promise<void>;
  deleteAsset: (id: string) => Promise<void>;
  uploadAsset: (form: FormData) => Promise<Asset>;
};

const MediaCtx = createContext<MediaContextValue | null>(null);

export function useMedia(): MediaContextValue {
  const value = useContext(MediaCtx);
  if (!value) throw new Error("useMedia must be used inside <MediaProvider>");
  return value;
}

export function MediaProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [gens, list] = await Promise.all([api.listGenerations(200), api.listAssets()]);
      setGenerations(gens.filter((g) => g.status === "completed" && g.audio_path));
      setAssets(list);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clips: MediaClip[] = useMemo(
    () => [
      ...generations.map<MediaClip>((g) => ({
        key: `g:${g.id}`,
        kind: "voice",
        title: truncate(g.text, 80),
        path: g.audio_path!,
        duration: g.duration_seconds,
        ref: { generation_id: g.id },
      })),
      ...assets.map<MediaClip>((a) => ({
        key: `a:${a.id}`,
        kind: a.kind,
        title: a.name,
        path: a.path,
        duration: a.duration_seconds,
        ref: { asset_id: a.id },
        assetId: a.id,
      })),
    ],
    [generations, assets],
  );

  const byKey = useMemo(() => new Map(clips.map((c) => [c.key, c])), [clips]);
  const intros = useMemo(() => assets.filter((a) => a.kind === "intro"), [assets]);
  const outros = useMemo(() => assets.filter((a) => a.kind === "outro"), [assets]);

  const deleteAsset = useCallback(
    async (id: string) => {
      await api.deleteAsset(id);
      await refresh();
    },
    [refresh],
  );

  const uploadAsset = useCallback(
    async (form: FormData) => {
      const asset = await api.uploadAsset(form);
      await refresh();
      return asset;
    },
    [refresh],
  );

  const value = useMemo(
    () => ({ clips, byKey, intros, outros, loading, refresh, deleteAsset, uploadAsset }),
    [clips, byKey, intros, outros, loading, refresh, deleteAsset, uploadAsset],
  );

  return <MediaCtx.Provider value={value}>{children}</MediaCtx.Provider>;
}
