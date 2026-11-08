export type Engine = "qwen" | "kokoro" | "kitten";

/** KittenTTS 2 decoding style: steadier, or more animated. */
export type KittenStyle = "stable" | "expressive";

export type GenerationStatus = "queued" | "processing" | "completed" | "failed";

export type AudioFormat = "wav" | "mp3" | "ogg" | "flac";

/** Where a profile is in the cloning step. */
export type VoiceStatus =
  | "not_needed"
  | "pending"
  | "preparing"
  | "ready"
  | "failed";

export interface Profile {
  id: string;
  name: string;
  engine: Engine;
  language: string;
  sample_path: string | null;
  sample_text: string | null;
  preset_voice: string | null;
  created_at: string;
  voice_status: VoiceStatus;
  /** The extracted voice print on disk — this is the clone. */
  voice_path: string | null;
  /** "icl" (sample + transcript) or "x-vector" (speaker embedding only). */
  voice_mode: string | null;
  voice_model_id: string | null;
  voice_error: string | null;
  voice_prepared_at: string | null;
}

/** What a generation produced. Rows from before music / SFX read as "speech". */
export type GenerationKind = "speech" | "music" | "sfx";

export interface Generation {
  id: string;
  profile_id: string | null;
  kind: GenerationKind;
  /** Engine that made it (null on rows that predate the column). */
  engine: string | null;
  /** Per-generation options (seed, preset, lyrics, …). */
  params: Record<string, unknown> | null;
  text: string;
  status: GenerationStatus;
  audio_path: string | null;
  /** Container it was written in — "wav", "mp3", … (null until it finishes). */
  format: string | null;
  duration_seconds: number | null;
  error: string | null;
  device: string | null;
  warning: string | null;
  created_at: string;
  completed_at: string | null;
  /** Starred in the Library. */
  favorite: boolean;
}

export interface Asset {
  id: string;
  name: string;
  kind: "intro" | "outro" | "clip" | "output";
  path: string;
  duration_seconds: number | null;
  format: string;
  size_bytes: number | null;
  created_at: string;
}

export interface EngineStatus {
  name: string;
  available: boolean;
  loaded: boolean;
  device: string | null;
  detail: string | null;
  model: string | null;
  /** Catalog entry the engine is using; null for an environment override. */
  model_id: string | null;
  model_downloaded: boolean;
  /** Installed on demand — don't warn that it's missing. */
  optional: boolean;
}

/** The two on-demand audio kinds (speech has profiles and its own endpoints). */
export type AudioKind = "music" | "sfx";

/** The ways to start from an existing clip. */
export type AudioEditMode = "variation" | "extend" | "replace";

/** `edit` of a generate-audio request: which clip, and what to do with it. */
export interface AudioEditRequest {
  mode: AudioEditMode;
  generation_id: string;
  /** Variation: 0.05–1, how far the result may move from the clip. */
  strength?: number;
  /** Replace: the part to regenerate, in seconds from the clip's start. */
  start_seconds?: number;
  end_seconds?: number;
}

/** One checkpoint of a music / SFX engine, with the limits a job on *it* gets here. */
export interface AudioModelInfo {
  id: string;
  title: string;
  /** Tells entries that share one repository apart ("packed", "emb4"). */
  variant: string | null;
  summary: string;
  /** The engine's default entry. */
  default: boolean;
  /** What the engine loads when a request names no model. */
  active: boolean;
  downloaded: boolean;
  /** This machine can't run it (it needs a newer GPU). */
  unavailable_reason: string | null;
  max_duration_seconds: number | null;
  default_steps: number | null;
  default_guidance: number | null;
  download_estimate_bytes: number | null;
  license_tier: LicenseTier;
  license_name: string | null;
  license_url: string | null;
  gated: boolean;
  /** Installed + weights + runnable here: a job naming it is accepted now. */
  ready: boolean;
}

/** One music / SFX engine and what this machine can do with it. */
export interface AudioEngine {
  name: string;
  kind: AudioKind;
  label: string;
  /** The engine its kind uses when none is named. */
  default: boolean;
  /** Its Python packages import. */
  installed: boolean;
  /** This hardware can run it; `unsupported_reason` says why not. */
  supported: boolean;
  unsupported_reason: string | null;
  /** Runs, with a caveat worth showing (slow, capped length). */
  warning: string | null;
  /** Longest clip on this hardware, in seconds. */
  max_duration_seconds: number | null;
  /** What a request without steps / guidance gets (null: the engine decides). */
  default_steps: number | null;
  default_guidance: number | null;
  loaded: boolean;
  device: string | null;
  model_id: string | null;
  model_title: string | null;
  model_downloaded: boolean;
  download_estimate_bytes: number | null;
  license_tier: LicenseTier;
  license_name: string | null;
  license_url: string | null;
  gated: boolean;
  /** Whether it can sing lyrics (music engines). */
  lyrics: boolean;
  /** Whether it can start from an existing clip (variation, extend, replace a part). */
  editing: boolean;
  /** Installed + weights + supported: a generation would be accepted now. */
  ready: boolean;
  /** Every checkpoint of the engine, the default first. */
  models: AudioModelInfo[];
}

/** Whether a Hugging Face token is available for gated downloads — never the token. */
export interface HfTokenStatus {
  configured: boolean;
  /** "app": pasted into VoiceCraft. "huggingface": HF_TOKEN or a CLI login. */
  source: "app" | "huggingface" | null;
}

export type DownloadState =
  | "queued"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadJob {
  state: DownloadState;
  downloaded_bytes: number;
  total_bytes: number;
  error: string | null;
}

export type LicenseTier = "open" | "conditional" | "noncommercial";

export interface Model {
  id: string;
  repo_id: string;
  title: string;
  category: string;
  /** Registry name of the engine that loads it — a speech, music or sfx engine. */
  engine: string;
  summary: string;
  notes: string[];
  languages: string[];
  clones_voices: boolean;
  needs_gpu: boolean;
  /** Why this machine can't run it (it needs a newer GPU); null when it can. */
  unavailable_reason: string | null;
  downloaded: boolean;
  /** Measured on disk; null until the model is downloaded. */
  size_bytes: number | null;
  download_estimate_bytes: number;
  active: boolean;
  engine_available: boolean;
  path: string | null;
  job: DownloadJob | null;
  /** Tells entries that share one repository apart ("packed", "emb4"). */
  variant: string | null;
  /** Other entries in the same repository — deleting one removes them all. */
  shared_with: string[];
  optional_engine: boolean;
  license_tier: LicenseTier;
  license_name: string | null;
  license_url: string | null;
  gated: boolean;
}

export interface ModelCategory {
  id: string;
  label: string;
}

export interface Models {
  models_dir: string;
  models_dir_exists: boolean;
  free_bytes: number | null;
  used_bytes: number;
  categories: ModelCategory[];
  models: Model[];
}

export interface Preferences {
  default_engine: Engine;
  default_language: string;
  default_output_format: AudioFormat;
  default_crossfade_ms: number;
  /** Where the Generate forms start; each form can change it per job. */
  default_music_seconds: number;
  default_music_vocals: "instrumental" | "vocals";
  default_sfx_seconds: number;
  default_sfx_takes: number;
  default_kitten_style: KittenStyle;
  /** Minutes idle before loaded models are unloaded; 0 keeps them loaded. */
  idle_unload_minutes: number;
}

export interface DirectoryInfo {
  key: string;
  label: string;
  path: string;
  files: number;
  bytes: number;
}

export interface GpuInfo {
  torch: string | null;
  cuda: boolean;
  device_name?: string | null;
  capability?: string;
  precision?: string;
  vram_free_bytes?: number;
  vram_total_bytes?: number;
  detail?: string | null;
}

export interface Settings {
  data_dir: string;
  db_path: string;
  db_bytes: number;
  settings_path: string;
  host: string;
  port: number;
  directories: DirectoryInfo[];
  free_bytes: number | null;
  ffmpeg: { available: boolean; ffmpeg_path: string; ffprobe_path: string };
  gpu: GpuInfo;
  engines_loaded: string[];
  preferences: Preferences;
}

/** Live machine load for the sidebar's resource panel (all fields optional). */
export interface Resources {
  ram_used_bytes: number | null;
  ram_total_bytes: number | null;
  cpu_percent: number | null;
  cpu_cores: number | null;
  cpu_vendor: string | null;
  gpu_name: string | null;
  gpu_backend: string | null;
  gpu_mem_used_bytes: number | null;
  gpu_mem_total_bytes: number | null;
}

export interface CleanupResult {
  files_removed: number;
  bytes_freed: number;
}

export interface Health {
  status: "ok" | "degraded";
  version: string;
  data_dir: string;
  ffmpeg: boolean;
  engines: EngineStatus[];
}

// --------------------------------------------------------------------------
// Timeline editor — mirrors backend/models.py's project schemas
// --------------------------------------------------------------------------

export interface SourceRef {
  generation_id?: string;
  asset_id?: string;
}

export interface EffectInstance {
  id: string;
  type: string;
  params: Record<string, number | string | boolean>;
  enabled: boolean;
}

export interface TimelineClip {
  id: string;
  track_id: string;
  source: SourceRef;
  start: number;
  in_point: number;
  out_point: number | null;
  gain_db: number;
  fade_in: number;
  fade_out: number;
  effects: EffectInstance[];
  muted: boolean;
}

export type TrackKind = "voice" | "music" | "sfx" | "other";

export interface DuckSettings {
  enabled: boolean;
  against_track_ids: string[];
  amount_db: number;
  attack_ms: number;
  release_ms: number;
}

export interface EditorTrack {
  id: string;
  name: string;
  kind: TrackKind;
  gain_db: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  effects: EffectInstance[];
  duck: DuckSettings;
}

export interface IntroOutroSlot {
  asset_id: string | null;
  crossfade_ms: number;
  gain_db: number;
}

export interface LoudnessSettings {
  enabled: boolean;
  target_lufs: number;
  true_peak: number;
}

export interface MasterBus {
  effects: EffectInstance[];
  loudness: LoudnessSettings;
}

export interface ExportSettings {
  output_format: AudioFormat;
  sample_rate: number;
  channels: number;
}

export interface Marker {
  id: string;
  time: number;
  label: string;
  color?: string | null;
}

export interface ProjectData {
  schema_version: number;
  tracks: EditorTrack[];
  clips: TimelineClip[];
  intro: IntroOutroSlot;
  outro: IntroOutroSlot;
  master: MasterBus;
  export: ExportSettings;
  markers: Marker[];
}

export interface Project {
  id: string;
  name: string;
  data: ProjectData;
  duration_seconds: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  duration_seconds: number | null;
  created_at: string;
  updated_at: string;
}

export interface EffectParamSpec {
  key: string;
  label: string;
  kind: "float" | "int" | "bool" | "choice";
  default: number | string | boolean;
  min: number | null;
  max: number | null;
  step: number | null;
  unit: string | null;
  choices: string[] | null;
}

export interface EffectSpec {
  type: string;
  label: string;
  category: string;
  preview: "webaudio" | "render";
  params: EffectParamSpec[];
}

export type RenderState = "queued" | "measuring" | "rendering" | "completed" | "failed" | "cancelled";

export interface RenderJob {
  id: string;
  state: RenderState;
  progress: number;
  asset: Asset | null;
  error: string | null;
}

export interface SilenceRegion {
  start: number;
  end: number;
}

export interface LoudnessReport {
  integrated_lufs: number | null;
  true_peak_db: number | null;
  loudness_range: number | null;
  threshold_db: number | null;
}
