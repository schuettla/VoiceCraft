import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Engine, Generation, Health, Profile } from "../lib/types";
import { formatBytes, formatWhen } from "../lib/format";
import { usePreferences } from "../lib/preferences";
import { useAudio } from "../components/AudioPlayer";
import { TrackRow } from "../components/TrackRow";
import { useToast } from "../components/Toaster";
import {
  Badge,
  Button,
  Empty,
  Field,
  IconButton,
  Input,
  Notice,
  Panel,
  Select,
} from "../components/ui";
import { SpinnerIcon, TrashIcon } from "../components/icons";

const LANGUAGES = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["ja", "Japanese"],
  ["zh", "Chinese"],
] as const;

/** A profile is still being cloned — the list re-polls while any is in flight. */
function inFlight(profile: Profile): boolean {
  return profile.voice_status === "pending" || profile.voice_status === "preparing";
}

export function ProfilesPage({ health }: { health: Health | null }) {
  const toast = useToast();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [voices, setVoices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // null means "whatever Settings says" until the user picks something else.
  const preferences = usePreferences();
  const [name, setName] = useState("");
  const [chosenEngine, setEngine] = useState<Engine | null>(null);
  const [chosenLanguage, setLanguage] = useState<string | null>(null);
  const engine = chosenEngine ?? preferences.default_engine;
  const language = chosenLanguage ?? preferences.default_language;
  const [presetVoice, setPresetVoice] = useState("af_heart");
  const [sampleText, setSampleText] = useState("");
  const [sample, setSample] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setProfiles(await api.listProfiles());
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
    api.kokoroVoices().then(setVoices).catch(() => setVoices([]));
  }, [refresh]);

  // Cloning happens on the backend's worker thread; poll while it runs so the
  // row turns green on its own rather than needing a page switch.
  const cloning = profiles.some(inFlight);
  useEffect(() => {
    if (!cloning) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [cloning, refresh]);

  const engineStatus = health?.engines.find((e) => e.name === engine);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const form = new FormData();
      form.set("name", name);
      form.set("engine", engine);
      form.set("language", language);
      if (engine === "kokoro") {
        form.set("preset_voice", presetVoice);
      } else {
        if (!sample) throw new ApiError("Choose a reference audio sample first.", 400);
        form.set("sample", sample);
        if (sampleText.trim()) form.set("sample_text", sampleText.trim());
      }
      await api.createProfile(form);
      toast(
        engine === "qwen"
          ? `Cloning “${name}” — the voice print is being extracted`
          : `Profile “${name}” created`,
        "success",
      );
      setName("");
      setSample(null);
      setSampleText("");
      if (fileInput.current) fileInput.current.value = "";
      await refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(profile: Profile) {
    if (!window.confirm(`Delete profile “${profile.name}”? Past generations are kept.`))
      return;
    try {
      await api.deleteProfile(profile.id);
      await refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  async function recloneVoice(profile: Profile) {
    try {
      await api.prepareVoice(profile.id);
      await refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
      <Panel title="New voice profile" subtitle="Clone from a sample, or pick a preset">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Name">
            <Input
              value={name}
              required
              maxLength={200}
              placeholder="Podcast host"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <Field
            label="Engine"
            hint={
              engine === "kokoro"
                ? "Kokoro cannot clone — it selects one of ~50 built-in voices. Fast, CPU-only."
                : "Qwen3-TTS clones zero-shot from your reference clip. Uses CUDA when available."
            }
          >
            <Select value={engine} onChange={(e) => setEngine(e.target.value as Engine)}>
              <option value="qwen">Qwen3-TTS — voice cloning</option>
              <option value="kokoro">Kokoro — preset voices (fast draft)</option>
            </Select>
          </Field>

          {engineStatus && !engineStatus.available && (
            <Notice tone="warn">
              {engineStatus.detail ?? "This engine is not installed."} Profiles can
              still be created; cloning and generation will fail until it is.
            </Notice>
          )}

          <Field label="Language">
            <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>

          {engine === "kokoro" ? (
            <Field label="Preset voice">
              <Select
                value={presetVoice}
                onChange={(e) => setPresetVoice(e.target.value)}
              >
                {voices.map((voice) => (
                  <option key={voice} value={voice}>
                    {voice}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <>
              <Field
                label="Reference sample"
                hint="10–30 seconds of clean speech works best."
              >
                <input
                  ref={fileInput}
                  type="file"
                  accept="audio/*"
                  onChange={(e) => setSample(e.target.files?.[0] ?? null)}
                  className="w-full text-[13px] text-ink-400 file:mr-3 file:rounded-md file:border-0 file:bg-ink-700 file:px-3 file:py-1.5 file:text-[13px] file:text-ink-200 hover:file:bg-ink-600"
                />
                {sample && (
                  <span className="mt-1 block text-[11px] text-ink-400">
                    {sample.name} · {formatBytes(sample.size)}
                  </span>
                )}
              </Field>
              <Field
                label="Sample transcript (optional)"
                hint="Exactly what the clip says. With it the model clones from audio and
                      text together; without it, from the speaker embedding alone, which
                      the model card says is noticeably weaker."
              >
                <Input
                  value={sampleText}
                  placeholder="Optional"
                  onChange={(e) => setSampleText(e.target.value)}
                />
              </Field>
              <Notice>
                Creating the profile clones the voice: the sample is run through the
                model once and the resulting voice print is saved, so every later
                generation reuses it.
              </Notice>
            </>
          )}

          <Button type="submit" variant="primary" disabled={busy} className="w-full">
            {busy
              ? "Creating…"
              : engine === "qwen"
                ? "Create and clone"
                : "Create profile"}
          </Button>
        </form>
      </Panel>

      <Panel
        title="Voices"
        subtitle={`${profiles.length} profile${profiles.length === 1 ? "" : "s"}`}
      >
        {profiles.length === 0 ? (
          <Empty>No profiles yet. Create one to start generating.</Empty>
        ) : (
          <div className="space-y-1">
            {profiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                onDelete={() => remove(profile)}
                onReclone={() => recloneVoice(profile)}
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function ProfileRow({
  profile,
  onDelete,
  onReclone,
}: {
  profile: Profile;
  onDelete: () => void;
  onReclone: () => void;
}) {
  const toast = useToast();
  const audio = useAudio();
  const [testing, setTesting] = useState(false);

  const ready =
    profile.voice_status === "ready" || profile.voice_status === "not_needed";

  /** Speak a fixed line, then play it in the shared player — proof the clone works. */
  async function test() {
    setTesting(true);
    try {
      let generation: Generation = await api.previewVoice(profile.id);
      while (
        generation.status === "queued" ||
        generation.status === "processing"
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        generation = await api.getGeneration(generation.id);
      }
      if (generation.status === "completed" && generation.audio_path) {
        audio.play({
          id: `preview:${generation.id}`,
          path: generation.audio_path,
          title: `Test — ${profile.name}`,
          subtitle: "this voice speaking",
        });
      } else {
        toast(generation.error ?? "The test generation failed.", "error");
      }
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setTesting(false);
    }
  }

  const meta = [
    profile.engine,
    profile.language,
    profile.preset_voice,
    formatWhen(profile.created_at),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <TrackRow
      track={
        profile.sample_path
          ? {
              id: `sample:${profile.id}`,
              path: profile.sample_path,
              title: profile.name,
              subtitle: "reference sample",
            }
          : undefined
      }
      title={profile.name}
      badge={<VoiceBadge profile={profile} />}
      meta={meta}
      detail={<VoiceDetail profile={profile} onReclone={onReclone} />}
      actions={
        <>
          <Button size="sm" disabled={!ready || testing} onClick={test}>
            {testing ? (
              <>
                <SpinnerIcon className="text-ink-400" /> Testing…
              </>
            ) : (
              "Test voice"
            )}
          </Button>
          <IconButton
            label="Delete profile"
            className="hover:text-coral-red"
            onClick={onDelete}
          >
            <TrashIcon />
          </IconButton>
        </>
      }
    />
  );
}

function VoiceBadge({ profile }: { profile: Profile }) {
  switch (profile.voice_status) {
    case "ready":
      return <Badge tone="good">ready</Badge>;
    case "preparing":
      return <Badge tone="busy">cloning…</Badge>;
    case "pending":
      return <Badge tone="busy">queued</Badge>;
    case "failed":
      return <Badge tone="bad">clone failed</Badge>;
    default:
      return <Badge tone="neutral">preset</Badge>;
  }
}

/** The line that explains what the profile actually holds. */
function VoiceDetail({
  profile,
  onReclone,
}: {
  profile: Profile;
  onReclone: () => void;
}) {
  if (profile.voice_status === "not_needed") {
    return (
      <p className="text-[11px] text-ink-400">
        Preset voice — nothing to clone. Kokoro speaks with a built-in timbre.
      </p>
    );
  }

  if (profile.voice_status === "failed") {
    return (
      <Notice tone="bad">
        {profile.voice_error ?? "The voice print could not be extracted."}
        <button
          type="button"
          onClick={onReclone}
          className="mt-1 block underline underline-offset-2 hover:opacity-80"
        >
          Try cloning again
        </button>
      </Notice>
    );
  }

  if (profile.voice_status !== "ready") {
    return (
      <p className="text-[11px] text-ink-400">
        {profile.voice_status === "preparing"
          ? "Extracting the voice print from the reference sample…"
          : "Waiting for the engine — cloning starts as soon as it is free."}
        {" The first run also loads the model, which takes a minute."}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-400">
      <span>
        Voice print saved
        {profile.voice_prepared_at ? ` ${formatWhen(profile.voice_prepared_at)}` : ""}
        {" · "}
        {profile.voice_mode === "icl"
          ? "sample + transcript"
          : "speaker embedding only"}
      </span>
      {profile.voice_mode !== "icl" && (
        <span className="text-[#e2b93b]">
          add a transcript and re-clone for a closer match
        </span>
      )}
      <button
        type="button"
        onClick={onReclone}
        className="underline underline-offset-2 hover:text-ink-200"
      >
        Re-clone
      </button>
    </div>
  );
}
