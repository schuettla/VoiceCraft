/**
 * Who made the models VoiceCraft can run, and under what terms. VoiceCraft
 * ships no weights: each one is downloaded from its own repository, and its
 * license is between the user and its authors (docs/audio-roadmap.md §1.1).
 *
 * The license links here must match the catalog (backend/catalog.py); a test in
 * backend/tests/test_audio.py fails if a catalog license link is missing here.
 */

export type Attribution = {
  name: string;
  /** What it is used for in the app. */
  role: string;
  /** Credit line the authors ask for, when they ask for one. */
  credit?: string;
  license: string;
  licenseUrl: string;
  /** The project's page (its Hugging Face model card). */
  sourceUrl: string;
};

const APACHE_2 = "https://www.apache.org/licenses/LICENSE-2.0";

export const ATTRIBUTIONS: Attribution[] = [
  {
    name: "Qwen3-TTS",
    role: "Speech with voice cloning",
    license: "Apache 2.0",
    licenseUrl: APACHE_2,
    sourceUrl: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base",
  },
  {
    name: "Kokoro",
    role: "Speech with preset voices",
    license: "Apache 2.0",
    licenseUrl: APACHE_2,
    sourceUrl: "https://huggingface.co/hexgrad/Kokoro-82M",
  },
  {
    name: "KittenTTS 2",
    role: "Speech with cloning and preset voices",
    credit: "Powered by KittenML",
    license: "Stellon Labs Community License",
    licenseUrl: "https://huggingface.co/KittenML/kitten-tts-2/blob/main/LICENSE.md",
    sourceUrl: "https://huggingface.co/KittenML/kitten-tts-2",
  },
  {
    name: "ACE-Step 1.5",
    role: "Music generation",
    license: "MIT",
    licenseUrl: "https://huggingface.co/ACE-Step/Ace-Step1.5",
    sourceUrl: "https://huggingface.co/ACE-Step/Ace-Step1.5",
  },
  {
    name: "MOSS-SoundEffect v2",
    role: "Sound effects",
    license: "Apache 2.0",
    licenseUrl: APACHE_2,
    sourceUrl: "https://huggingface.co/OpenMOSS-Team/MOSS-SoundEffect-v2.0",
  },
  {
    name: "Stable Audio 3 Small — music",
    role: "Lite music generation (gated download)",
    credit: "Powered by Stability AI",
    license: "Stability AI Community License",
    licenseUrl: "https://stability.ai/license",
    sourceUrl: "https://huggingface.co/stabilityai/stable-audio-3-small-music",
  },
  {
    name: "Stable Audio 3 Small — sound effects",
    role: "Lite sound-effect generation (gated download)",
    license: "Stability AI Community License",
    licenseUrl: "https://stability.ai/license",
    sourceUrl: "https://huggingface.co/stabilityai/stable-audio-3-small-sfx",
  },
];
