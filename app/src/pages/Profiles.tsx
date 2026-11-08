import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Engine, Generation, Health, Profile } from "../lib/types";
import { formatBytes, formatWhen } from "../lib/format";
import { usePreferences } from "../lib/preferences";
import { useAudio } from "../components/AudioPlayer";
import { TrackRow } from "../components/TrackRow";
import { useToast } from "../components/Toaster";
import { useConfirm } from "../components/Confirm";
import {
  Badge,
  Empty,
  Field,
  IconButton,
  Notice,
  OptionSelect,
  PageHeader,
} from "../components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Plus } from "lucide-react";
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

const DEFAULT_KITTEN_VOICE = "Bruno";

const ENGINE_HINTS: Record<Engine, string> = {
  qwen: "Qwen3-TTS clones zero-shot from your reference clip. Uses CUDA when available.",
  kokoro: "Kokoro cannot clone — it selects one of ~50 built-in voices. Fast, CPU-only.",
  kitten:
    "KittenTTS 2 clones from a 5–30 s clip plus its transcript, or speaks with one of 115 built-in voices, in 20 languages. Wants a CUDA GPU; on CPU it is far slower than real time.",
};

/** "AirportAnnouncer" → "Airport Announcer", for KittenTTS 2's CamelCase voice names. */
function spaced(voice: string): string {
  return voice.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** A profile is still being cloned — the list re-polls while any is in flight. */
function inFlight(profile: Profile): boolean {
  return profile.voice_status === "pending" || profile.voice_status === "preparing";
}

export function ProfilesPage({ health }: { health: Health | null }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
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
  const [chosenVoice, setPresetVoice] = useState<string | null>(null);
  // A KittenTTS 2 profile is a clone *or* a preset, never both.
  const [kittenMode, setKittenMode] = useState<"clone" | "preset">("clone");
  const [sampleText, setSampleText] = useState("");
  const [sample, setSample] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const usesPreset = engine === "kokoro" || (engine === "kitten" && kittenMode === "preset");
  // Each engine has its own voice list, so a stale choice (Kokoro's af_heart
  // while Kitten is selected) falls back to that engine's first sensible one.
  const presetVoice =
    chosenVoice && voices.includes(chosenVoice)
      ? chosenVoice
      : voices.includes(DEFAULT_KITTEN_VOICE) && engine === "kitten"
        ? DEFAULT_KITTEN_VOICE
        : (voices[0] ?? "");

  const refresh = useCallback(async () => {
    try {
      setProfiles(await api.listProfiles());
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (engine === "qwen") {
      setVoices([]);
      return;
    }
    let live = true;
    api
      .presetVoices(engine)
      .then((list) => live && setVoices(list))
      .catch(() => live && setVoices([]));
    return () => {
      live = false;
    };
  }, [engine]);

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
      if (usesPreset) {
        if (!presetVoice) throw new ApiError("Choose a preset voice first.", 400);
        form.set("preset_voice", presetVoice);
      } else {
        if (!sample) throw new ApiError("Choose a reference audio sample first.", 400);
        // KittenTTS 2 would otherwise download Whisper (~3 GB) to transcribe it.
        if (engine === "kitten" && !sampleText.trim()) {
          throw new ApiError("KittenTTS 2 needs the transcript of the sample.", 400);
        }
        form.set("sample", sample);
        if (sampleText.trim()) form.set("sample_text", sampleText.trim());
      }
      await api.createProfile(form);
      toast(
        usesPreset
          ? `Profile “${name}” created`
          : `Cloning “${name}” — the voice print is being extracted`,
        "success",
      );
      setName("");
      setSample(null);
      setSampleText("");
      if (fileInput.current) fileInput.current.value = "";
      setCreating(false);
      await refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(profile: Profile) {
    const ok = await confirm({
      title: `Delete “${profile.name}”?`,
      description: "The voice profile is removed. Past generations are kept.",
      confirmLabel: "Delete profile",
      destructive: true,
    });
    if (!ok) return;
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
    <>
      <PageHeader
        title="Profiles"
        description={`${profiles.length} voice${profiles.length === 1 ? "" : "s"} — clone from a sample, or pick a preset.`}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New profile
          </Button>
        }
      />

      {profiles.length === 0 ? (
        <Empty title="No voices yet">
          Create a profile to start generating.
        </Empty>
      ) : (
        <div className="divide-y border-y">
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

      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>New voice profile</SheetTitle>
            <SheetDescription>Clone from a sample, or pick a preset voice.</SheetDescription>
          </SheetHeader>

          <form id="profile-form" onSubmit={submit} className="space-y-4 px-4">
            <Field label="Name">
              <Input
                value={name}
                required
                maxLength={200}
                placeholder="Podcast host"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>

            <Field label="Engine" hint={ENGINE_HINTS[engine]}>
              <OptionSelect
                value={engine}
                onChange={(value) => setEngine(value as Engine)}
                options={[
                  { value: "qwen", label: "Qwen3-TTS — voice cloning" },
                  { value: "kitten", label: "KittenTTS 2 — cloning + 115 presets" },
                  { value: "kokoro", label: "Kokoro — preset voices (fast draft)" },
                ]}
              />
            </Field>

            {engine === "kitten" && (
              <Field label="Voice source">
                <OptionSelect
                  value={kittenMode}
                  onChange={(value) => setKittenMode(value as "clone" | "preset")}
                  options={[
                    { value: "clone", label: "Clone from a sample" },
                    { value: "preset", label: "One of the built-in voices" },
                  ]}
                />
              </Field>
            )}

            {engineStatus && !engineStatus.available && (
              <Notice tone="warn">
                {engineStatus.detail ?? "This engine is not installed."} Profiles can
                still be created; cloning and generation will fail until it is.
              </Notice>
            )}

            {/* KittenTTS 2 takes no language setting: it speaks the language of the text. */}
            {engine !== "kitten" && (
              <Field label="Language">
                <OptionSelect
                  value={language}
                  onChange={setLanguage}
                  options={LANGUAGES.map(([code, label]) => ({ value: code, label }))}
                />
              </Field>
            )}

            {usesPreset ? (
              <Field
                label="Preset voice"
                hint={
                  engine === "kitten"
                    ? "Many voices are tied to one language; pick one that matches your text."
                    : undefined
                }
              >
                <OptionSelect
                  value={presetVoice}
                  onChange={setPresetVoice}
                  options={voices.map((voice) => ({
                    value: voice,
                    label: engine === "kitten" ? spaced(voice) : voice,
                  }))}
                />
              </Field>
            ) : (
              <>
                <Field
                  label="Reference sample"
                  hint="10–30 seconds of clean speech works best."
                >
                  <Input
                    ref={fileInput}
                    type="file"
                    accept="audio/*"
                    onChange={(e) => setSample(e.target.files?.[0] ?? null)}
                  />
                  {sample && (
                    <span className="text-xs text-muted-foreground">
                      {sample.name} · {formatBytes(sample.size)}
                    </span>
                  )}
                </Field>
                <Field
                  label={engine === "kitten" ? "Sample transcript" : "Sample transcript (optional)"}
                  hint={
                    engine === "kitten"
                      ? "Required: exactly what the clip says. 5–30 s, a single speaker. Without it the engine would download a 3 GB speech-recognition model."
                      : "Exactly what the clip says. With it the model clones from audio and text together; without it, from the speaker embedding alone, which the model card says is noticeably weaker."
                  }
                >
                  <Input
                    value={sampleText}
                    required={engine === "kitten"}
                    placeholder={engine === "kitten" ? "What the sample says" : "Optional"}
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
          </form>

          <SheetFooter>
            <Button type="submit" form="profile-form" disabled={busy}>
              {busy && <SpinnerIcon />}
              {busy ? "Creating…" : usesPreset ? "Create profile" : "Create and clone"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
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
    profile.engine === "kitten" ? null : profile.language,
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
          <Button size="sm" variant="outline" disabled={!ready || testing} onClick={test}>
            {testing ? (
              <>
                <SpinnerIcon /> Testing…
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
      <p className="text-xs text-muted-foreground">
        Preset voice — nothing to clone.{" "}
        {profile.engine === "kitten"
          ? "KittenTTS 2 speaks with one of its built-in voices."
          : "Kokoro speaks with a built-in timbre."}
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
      <p className="text-xs text-muted-foreground">
        {profile.voice_status === "preparing"
          ? "Extracting the voice print from the reference sample…"
          : "Waiting for the engine — cloning starts as soon as it is free."}
        {" The first run also loads the model, which takes a minute."}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>
        Voice print saved
        {profile.voice_prepared_at ? ` ${formatWhen(profile.voice_prepared_at)}` : ""}
        {" · "}
        {profile.voice_mode === "icl"
          ? "sample + transcript"
          : "speaker embedding only"}
      </span>
      {profile.voice_mode !== "icl" && (
        <span className="text-warning">
          add a transcript and re-clone for a closer match
        </span>
      )}
      <button
        type="button"
        onClick={onReclone}
        className="underline underline-offset-2 hover:text-foreground"
      >
        Re-clone
      </button>
    </div>
  );
}
