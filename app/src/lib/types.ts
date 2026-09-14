export type Engine = "qwen" | "kokoro";

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

export interface Generation {
  id: string;
  profile_id: string | null;
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
  model_downloaded: boolean;
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

export interface Model {
  id: string;
  repo_id: string;
  title: string;
  category: string;
  engine: Engine;
  summary: string;
  notes: string[];
  languages: string[];
  clones_voices: boolean;
  needs_gpu: boolean;
  downloaded: boolean;
  /** Measured on disk; null until the model is downloaded. */
  size_bytes: number | null;
  download_estimate_bytes: number;
  active: boolean;
  engine_available: boolean;
  path: string | null;
  job: DownloadJob | null;
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
