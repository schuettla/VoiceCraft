import type { Resources,
  Asset,
  AudioEngine,
  AudioFormat,
  AudioKind,
  CleanupResult,
  EffectSpec,
  Engine,
  Generation,
  GenerationKind,
  Health,
  HfTokenStatus,
  KittenStyle,
  LoudnessReport,
  Models,
  Preferences,
  Profile,
  Project,
  ProjectData,
  ProjectSummary,
  RenderJob,
  Settings,
  SilenceRegion,
} from "./types";

// The backend always listens on this loopback port (PRD §6). Nothing here ever
// talks to a remote host.
export const API_BASE = "http://127.0.0.1:17610";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch {
    throw new ApiError("Backend unreachable — is the VoiceCraft server running?", 0);
  }
  if (!response.ok) {
    throw new ApiError(await readError(response), response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (typeof detail === "string") return detail;
    // FastAPI validation errors arrive as a list of {loc, msg}.
    if (Array.isArray(detail)) {
      return detail.map((d: { msg?: string }) => d.msg ?? "invalid input").join("; ");
    }
  } catch {
    /* fall through to the status text */
  }
  return `${response.status} ${response.statusText}`;
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** URL the <audio> element can play a managed file from. */
export function fileUrl(path: string): string {
  return `${API_BASE}/api/files?path=${encodeURIComponent(path)}`;
}

export const api = {
  health: () => request<Health>("/api/health"),

  listProfiles: () => request<Profile[]>("/api/profiles"),
  /** Built-in voices an engine offers for preset profiles (qwen has none). */
  presetVoices: (engine: Engine) =>
    request<string[]>(`/api/profiles/voices?engine=${engine}`),
  createProfile: (form: FormData) =>
    request<Profile>("/api/profiles", { method: "POST", body: form }),
  deleteProfile: (id: string) =>
    request<void>(`/api/profiles/${id}`, { method: "DELETE" }),
  /** Re-extract the voice print from the profile's reference sample. */
  prepareVoice: (id: string) =>
    request<Profile>(`/api/profiles/${id}/prepare`, { method: "POST" }),
  /** Queue a short test line in this voice; returns the generation to poll. */
  previewVoice: (id: string) =>
    request<Generation>(`/api/profiles/${id}/preview`, { method: "POST" }),

  listGenerations: (limit?: number, kind?: GenerationKind) => {
    const query = new URLSearchParams();
    if (limit) query.set("limit", String(limit));
    if (kind) query.set("kind", kind);
    const text = query.toString();
    return request<Generation[]>(`/api/generations${text ? `?${text}` : ""}`);
  },
  /** Music and sound-effect engines, with install / hardware state. */
  listAudioEngines: () => request<AudioEngine[]>("/api/audio-engines"),
  /** Queue a music or SFX job. Returns one queued row per take. */
  generateAudio: (body: {
    kind: AudioKind;
    engine?: string;
    prompt: string;
    duration_seconds: number;
    lyrics?: string;
    seed?: number;
    steps?: number;
    guidance?: number;
    /** Sound effects only, 1–4. */
    takes?: number;
    output_format?: AudioFormat;
  }) => request<Generation[]>("/api/generations/audio", json(body)),
  generate: (body: {
    profile_id: string;
    text: string;
    speed?: number;
    output_format?: AudioFormat;
    /** KittenTTS 2 only; other engines ignore them. */
    preset?: KittenStyle;
    seed?: number;
  }) => request<Generation>("/api/generations", json(body)),
  getGeneration: (id: string) => request<Generation>(`/api/generations/${id}`),
  deleteGeneration: (id: string) =>
    request<void>(`/api/generations/${id}`, { method: "DELETE" }),

  // Every model mutation answers with the whole page state, so the UI never
  // has to guess what a download or a delete did to the rest of the list.
  listModels: () => request<Models>("/api/models"),
  downloadModel: (id: string) =>
    request<Models>(`/api/models/${id}/download`, { method: "POST" }),
  cancelModelDownload: (id: string) =>
    request<Models>(`/api/models/${id}/cancel`, { method: "POST" }),
  selectModel: (id: string) =>
    request<Models>(`/api/models/${id}/select`, { method: "POST" }),
  deleteModel: (id: string) =>
    request<Models>(`/api/models/${id}`, { method: "DELETE" }),
  setModelsDir: (path: string) => request<Models>("/api/models/storage", json({ path })),
  /** Whether a Hugging Face token is available for gated downloads. Never the token. */
  hfTokenStatus: () => request<HfTokenStatus>("/api/models/hf-token"),
  saveHfToken: (token: string) =>
    request<HfTokenStatus>("/api/models/hf-token", { ...json({ token }), method: "PUT" }),
  clearHfToken: () => request<HfTokenStatus>("/api/models/hf-token", { method: "DELETE" }),
  openModelsDir: () =>
    request<void>("/api/models/storage/open", { method: "POST" }),

  listAssets: () => request<Asset[]>("/api/edit/assets"),
  uploadAsset: (form: FormData) =>
    request<Asset>("/api/edit/assets", { method: "POST", body: form }),
  deleteAsset: (id: string) =>
    request<void>(`/api/edit/assets/${id}`, { method: "DELETE" }),

  trim: (body: {
    generation_id?: string;
    asset_id?: string;
    start: number;
    end?: number | null;
    output_format: AudioFormat;
    name?: string;
  }) => request<Asset>("/api/edit/trim", json(body)),

  assemble: (body: {
    intro_asset_id?: string | null;
    outro_asset_id?: string | null;
    segments: { generation_id?: string; asset_id?: string }[];
    crossfade_ms: number;
    output_format: AudioFormat;
    name?: string;
  }) => request<Asset>("/api/edit/assemble", json(body)),

  convert: (body: {
    generation_id?: string;
    asset_id?: string;
    output_format: AudioFormat;
    name?: string;
  }) => request<Asset>("/api/edit/convert", json(body)),

  reveal: (path: string) => request<void>("/api/edit/reveal", json({ path })),

  // Timeline editor -----------------------------------------------------

  listProjects: () => request<ProjectSummary[]>("/api/edit/projects"),
  createProject: (name: string, data: ProjectData) =>
    request<Project>("/api/edit/projects", json({ name, data })),
  getProject: (id: string) => request<Project>(`/api/edit/projects/${id}`),
  saveProject: (id: string, name: string, data: ProjectData) =>
    request<Project>(`/api/edit/projects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, data }),
    }),
  deleteProject: (id: string) =>
    request<void>(`/api/edit/projects/${id}`, { method: "DELETE" }),

  listEffects: () => request<EffectSpec[]>("/api/edit/effects"),

  /** Binary min/max waveform peaks for one source; buckets are `resolution`/s. */
  peaks: async (
    source: { generation_id?: string; asset_id?: string },
    resolution: number,
  ): Promise<{ data: Int8Array; duration: number }> => {
    const params = new URLSearchParams({ resolution: String(resolution) });
    if (source.generation_id) params.set("generation_id", source.generation_id);
    if (source.asset_id) params.set("asset_id", source.asset_id);
    let response: Response;
    try {
      response = await fetch(`${API_BASE}/api/edit/peaks?${params}`);
    } catch {
      throw new ApiError("Backend unreachable — is the VoiceCraft server running?", 0);
    }
    if (!response.ok) throw new ApiError(await readError(response), response.status);
    const duration = Number(response.headers.get("X-Duration") ?? "0");
    const buffer = await response.arrayBuffer();
    return { data: new Int8Array(buffer), duration };
  },

  analyzeSilence: (body: {
    generation_id?: string;
    asset_id?: string;
    noise_db?: number;
    min_duration?: number;
  }) => request<{ regions: SilenceRegion[] }>("/api/edit/analyze/silence", json(body)),

  analyzeLoudness: (body: { generation_id?: string; asset_id?: string }) =>
    request<LoudnessReport>("/api/edit/analyze/loudness", json(body)),

  previewClip: (clipId: string, data: ProjectData) =>
    request<{ path: string }>(
      "/api/edit/preview",
      json({ clip_id: clipId, data }),
    ),

  /** Freeze a clip's effect chain (optionally a [start,end) sub-range of it)
   * into a new, reusable `clip` asset — the source clip is untouched. */
  bounce: (body: {
    clip_id: string;
    data: ProjectData;
    start?: number;
    end?: number;
    name?: string;
    output_format?: AudioFormat;
  }) => request<Asset>("/api/edit/bounce", json(body)),

  startRender: (projectId: string, name?: string, data?: ProjectData) =>
    request<RenderJob>(`/api/edit/projects/${projectId}/render`, json({ name, data })),
  getRenderJob: (jobId: string) => request<RenderJob>(`/api/edit/render/${jobId}`),
  cancelRender: (jobId: string) =>
    request<void>(`/api/edit/render/${jobId}/cancel`, { method: "POST" }),

  settings: () => request<Settings>("/api/settings"),
  resources: () => request<Resources>("/api/settings/resources"),
  savePreferences: (preferences: Preferences) =>
    request<Settings>("/api/settings/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preferences),
    }),
  unloadModels: () => request<Settings>("/api/settings/unload", { method: "POST" }),
  cleanup: () => request<CleanupResult>("/api/settings/cleanup", { method: "POST" }),
  openDirectory: (key: string) => request<void>("/api/settings/open", json({ key })),
};
