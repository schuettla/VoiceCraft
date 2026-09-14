"""The ffmpeg effects registry: what shows up in the editor's effects chain.

Each `EffectSpec` is a small, self-contained description of one audio filter:
a label and category for the UI, a param schema the inspector builds its
sliders from, and a `build()` that turns a validated params dict into a
fragment of an ffmpeg filter graph (no leading/trailing comma, no labels).
`utils.timeline` calls `build()` for every enabled effect in a clip/track/
master chain and joins the fragments with commas.

Adding an effect is a backend-only change — the frontend renders whatever
`GET /api/edit/effects` returns.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Callable, Literal

import config
from utils.audio import _run  # noqa: PLC0415 - reuses the one subprocess wrapper

log = logging.getLogger(__name__)

ParamKind = Literal["float", "int", "bool", "choice"]


@dataclass
class ParamSpec:
    key: str
    label: str
    kind: ParamKind
    default: Any
    min: float | None = None
    max: float | None = None
    step: float | None = None
    unit: str | None = None
    choices: list[str] | None = None


@dataclass
class EffectSpec:
    type: str
    label: str
    category: str
    # "webaudio": the frontend approximates it live with native nodes.
    # "render": only ffmpeg can do it — auditioning re-renders the clip.
    preview: Literal["webaudio", "render"]
    params: list[ParamSpec]
    build: Callable[[dict[str, Any]], str]
    # ffmpeg filter names this effect needs; used to hide it if the local
    # ffmpeg build was compiled without them.
    requires: tuple[str, ...] = field(default_factory=tuple)


def _coerce(param: ParamSpec, value: Any) -> Any:
    """Clamp numbers to the spec's range and reject unknown choices — values are
    interpolated straight into the filter graph, so nothing unvalidated gets in."""
    if param.kind == "choice":
        return value if str(value) in (param.choices or []) else param.default
    if param.kind == "bool":
        return bool(value)
    try:
        number = float(value)
    except (TypeError, ValueError):
        return param.default
    if number != number:  # NaN
        return param.default
    if param.min is not None:
        number = max(param.min, number)
    if param.max is not None:
        number = min(param.max, number)
    return int(number) if param.kind == "int" else number


def _values(spec: EffectSpec, params: dict[str, Any]) -> dict[str, Any]:
    """Params merged over their defaults, so a partial dict from the client is safe."""
    return {p.key: _coerce(p, params.get(p.key, p.default)) for p in spec.params}


def _num(v: Any) -> float:
    return float(v)


# --------------------------------------------------------------------------
# Level & dynamics
# --------------------------------------------------------------------------

_gain = EffectSpec(
    "gain", "Gain", "Level & dynamics", "webaudio",
    [ParamSpec("db", "Gain", "float", 0.0, -60.0, 24.0, 0.5, "dB")],
    lambda p: f"volume={_num(p['db']):.2f}dB",
)

_normalize = EffectSpec(
    "normalize", "Auto level", "Level & dynamics", "render",
    [ParamSpec("target_db", "Target", "float", -14.0, -40.0, -6.0, 0.5, "dB")],
    lambda p: f"dynaudnorm=f=250:g=15:p={min(1.0, max(0.1, 1 + _num(p['target_db']) / 40)):.3f}",
    requires=("dynaudnorm",),
)

_compressor = EffectSpec(
    "compressor", "Compressor", "Level & dynamics", "webaudio",
    [
        ParamSpec("threshold_db", "Threshold", "float", -18.0, -60.0, 0.0, 0.5, "dB"),
        ParamSpec("ratio", "Ratio", "float", 3.0, 1.0, 20.0, 0.5, ":1"),
        ParamSpec("attack_ms", "Attack", "float", 20.0, 1.0, 200.0, 1.0, "ms"),
        ParamSpec("release_ms", "Release", "float", 250.0, 20.0, 2000.0, 10.0, "ms"),
        ParamSpec("makeup_db", "Makeup", "float", 0.0, 0.0, 24.0, 0.5, "dB"),
    ],
    lambda p: (
        f"acompressor=threshold={10 ** (_num(p['threshold_db']) / 20):.5f}:"
        f"ratio={_num(p['ratio']):.2f}:attack={_num(p['attack_ms']):.1f}:"
        f"release={_num(p['release_ms']):.1f}:makeup={10 ** (_num(p['makeup_db']) / 20):.3f}"
    ),
    requires=("acompressor",),
)

_limiter = EffectSpec(
    "limiter", "Limiter", "Level & dynamics", "render",
    [ParamSpec("ceiling_db", "Ceiling", "float", -1.0, -12.0, 0.0, 0.1, "dB")],
    lambda p: f"alimiter=limit={10 ** (_num(p['ceiling_db']) / 20):.4f}",
    requires=("alimiter",),
)

_gate = EffectSpec(
    "gate", "Noise gate", "Level & dynamics", "render",
    [
        ParamSpec("threshold_db", "Threshold", "float", -40.0, -80.0, 0.0, 0.5, "dB"),
        ParamSpec("attack_ms", "Attack", "float", 5.0, 0.1, 200.0, 0.5, "ms"),
        ParamSpec("release_ms", "Release", "float", 150.0, 1.0, 2000.0, 5.0, "ms"),
    ],
    lambda p: (
        f"agate=threshold={10 ** (_num(p['threshold_db']) / 20):.5f}:"
        f"attack={_num(p['attack_ms']):.1f}:release={_num(p['release_ms']):.1f}"
    ),
    requires=("agate",),
)

# --------------------------------------------------------------------------
# EQ & filter
# --------------------------------------------------------------------------

_highpass = EffectSpec(
    "highpass", "High-pass", "EQ & filter", "webaudio",
    [ParamSpec("hz", "Cutoff", "float", 80.0, 20.0, 2000.0, 1.0, "Hz")],
    lambda p: f"highpass=f={_num(p['hz']):.0f}",
)

_lowpass = EffectSpec(
    "lowpass", "Low-pass", "EQ & filter", "webaudio",
    [ParamSpec("hz", "Cutoff", "float", 12000.0, 200.0, 20000.0, 10.0, "Hz")],
    lambda p: f"lowpass=f={_num(p['hz']):.0f}",
)

_bass = EffectSpec(
    "bass", "Bass shelf", "EQ & filter", "webaudio",
    [
        ParamSpec("hz", "Frequency", "float", 100.0, 20.0, 500.0, 1.0, "Hz"),
        ParamSpec("gain_db", "Gain", "float", 0.0, -20.0, 20.0, 0.5, "dB"),
    ],
    lambda p: f"bass=frequency={_num(p['hz']):.0f}:gain={_num(p['gain_db']):.1f}",
)

_treble = EffectSpec(
    "treble", "Treble shelf", "EQ & filter", "webaudio",
    [
        ParamSpec("hz", "Frequency", "float", 8000.0, 2000.0, 16000.0, 10.0, "Hz"),
        ParamSpec("gain_db", "Gain", "float", 0.0, -20.0, 20.0, 0.5, "dB"),
    ],
    lambda p: f"treble=frequency={_num(p['hz']):.0f}:gain={_num(p['gain_db']):.1f}",
)

_eq_band = EffectSpec(
    "eq_band", "EQ band", "EQ & filter", "webaudio",
    [
        ParamSpec("hz", "Frequency", "float", 1000.0, 20.0, 20000.0, 1.0, "Hz"),
        ParamSpec("width_q", "Q", "float", 1.0, 0.1, 10.0, 0.1, None),
        ParamSpec("gain_db", "Gain", "float", 0.0, -20.0, 20.0, 0.5, "dB"),
    ],
    lambda p: (
        f"equalizer=f={_num(p['hz']):.0f}:width_type=q:"
        f"w={_num(p['width_q']):.2f}:g={_num(p['gain_db']):.1f}"
    ),
)

_telephone = EffectSpec(
    "telephone", "Telephone / radio", "EQ & filter", "render",
    [],
    lambda p: "highpass=f=300,lowpass=f=3400",
)

# --------------------------------------------------------------------------
# Restoration
# --------------------------------------------------------------------------

_denoise = EffectSpec(
    "denoise", "Noise reduction", "Restoration", "render",
    [ParamSpec("amount_db", "Amount", "float", 12.0, 0.0, 40.0, 1.0, "dB")],
    lambda p: f"afftdn=nr={_num(p['amount_db']):.1f}:nf=-25",
    requires=("afftdn",),
)

_declick = EffectSpec(
    "declick", "De-click", "Restoration", "render",
    [], lambda p: "adeclick", requires=("adeclick",),
)

_declip = EffectSpec(
    "declip", "De-clip", "Restoration", "render",
    [], lambda p: "adeclip", requires=("adeclip",),
)

_hum_removal = EffectSpec(
    "hum_removal", "Hum removal", "Restoration", "render",
    [ParamSpec("hz", "Mains frequency", "choice", "60", choices=["50", "60"])],
    lambda p: (
        f"bandreject=f={p['hz']}:width_type=h:w=4,"
        f"bandreject=f={int(p['hz']) * 2}:width_type=h:w=4"
    ),
)

_silence_trim = EffectSpec(
    "silence_trim", "Trim silence", "Restoration", "render",
    [
        ParamSpec("threshold_db", "Threshold", "float", -30.0, -80.0, 0.0, 1.0, "dB"),
        ParamSpec("min_duration", "Min duration", "float", 0.3, 0.05, 5.0, 0.05, "s"),
    ],
    lambda p: (
        f"silenceremove=start_periods=1:start_duration={_num(p['min_duration']):.2f}:"
        f"start_threshold={_num(p['threshold_db']):.1f}dB:"
        f"stop_periods=-1:stop_duration={_num(p['min_duration']):.2f}:"
        f"stop_threshold={_num(p['threshold_db']):.1f}dB"
    ),
    requires=("silenceremove",),
)

# --------------------------------------------------------------------------
# Time & pitch
# --------------------------------------------------------------------------


def _tempo_chain(rate: float) -> str:
    """atempo only accepts [0.5, 2.0] — chain stages to cover a wider range."""
    rate = max(0.25, min(4.0, rate))
    stages: list[str] = []
    remaining = rate
    while remaining < 0.5 or remaining > 2.0:
        step = 2.0 if remaining > 2.0 else 0.5
        stages.append(f"atempo={step}")
        remaining /= step
    stages.append(f"atempo={remaining:.4f}")
    return ",".join(stages)


_tempo = EffectSpec(
    "tempo", "Tempo", "Time & pitch", "render",
    [ParamSpec("rate", "Rate", "float", 1.0, 0.5, 2.0, 0.05, "x")],
    lambda p: _tempo_chain(_num(p["rate"])),
)

_pitch = EffectSpec(
    "pitch", "Pitch shift", "Time & pitch", "render",
    [ParamSpec("semitones", "Semitones", "float", 0.0, -12.0, 12.0, 0.5, "st")],
    # asetrate changes both pitch and speed; aresample back to the working rate
    # and atempo the inverse of the ratio restores the original duration.
    lambda p: (
        lambda ratio: (
            f"asetrate={config.INTERMEDIATE_SAMPLE_RATE * ratio:.2f},"
            f"aresample={config.INTERMEDIATE_SAMPLE_RATE},"
            f"{_tempo_chain(1 / ratio)}"
        )
    )(2 ** (_num(p["semitones"]) / 12)),
)

_reverse = EffectSpec(
    "reverse", "Reverse", "Time & pitch", "render",
    [], lambda p: "areverse",
)

# --------------------------------------------------------------------------
# Space & creative
# --------------------------------------------------------------------------

_echo = EffectSpec(
    "echo", "Echo", "Space & creative", "render",
    [
        ParamSpec("delay_ms", "Delay", "float", 400.0, 10.0, 2000.0, 10.0, "ms"),
        ParamSpec("decay", "Decay", "float", 0.4, 0.0, 0.95, 0.05, None),
    ],
    lambda p: f"aecho=0.8:0.9:{_num(p['delay_ms']):.0f}:{_num(p['decay']):.2f}",
    requires=("aecho",),
)

_reverb = EffectSpec(
    "reverb", "Reverb (room)", "Space & creative", "render",
    [ParamSpec("mix", "Mix", "float", 0.3, 0.0, 1.0, 0.05, None)],
    # A cheap multi-tap reverb built from aecho — no external IR needed.
    lambda p: (
        f"aecho=1.0:{_num(p['mix']):.2f}:60|150|280:0.5|0.35|0.2"
    ),
    requires=("aecho",),
)

_chorus = EffectSpec(
    "chorus", "Chorus", "Space & creative", "render",
    [ParamSpec("depth", "Depth", "float", 0.4, 0.0, 1.0, 0.05, None)],
    lambda p: f"chorus=0.5:0.9:50|60|40:0.4|0.3|{max(0.05, _num(p['depth'])):.2f}:0.25|0.4|0.3:2|2.3|1.3",
    requires=("chorus",),
)

_flanger = EffectSpec(
    "flanger", "Flanger", "Space & creative", "render",
    [ParamSpec("depth", "Depth", "float", 2.0, 0.0, 10.0, 0.5, "ms")],
    lambda p: f"flanger=delay=0:depth={_num(p['depth']):.2f}",
    requires=("flanger",),
)

_phaser = EffectSpec(
    "phaser", "Phaser", "Space & creative", "render",
    [ParamSpec("speed", "Speed", "float", 0.5, 0.1, 4.0, 0.1, "Hz")],
    lambda p: f"aphaser=speed={_num(p['speed']):.2f}",
    requires=("aphaser",),
)

_stereo_widen = EffectSpec(
    "stereo_widen", "Stereo widen", "Space & creative", "render",
    [ParamSpec("width", "Width", "float", 1.5, 0.0, 3.0, 0.1, None)],
    lambda p: f"extrastereo=m={_num(p['width']):.2f}",
    requires=("extrastereo",),
)

_mono = EffectSpec(
    "mono", "Mono downmix", "Space & creative", "webaudio",
    [], lambda p: "pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1",
)

REGISTRY: dict[str, EffectSpec] = {
    spec.type: spec
    for spec in [
        _gain, _normalize, _compressor, _limiter, _gate,
        _highpass, _lowpass, _bass, _treble, _eq_band, _telephone,
        _denoise, _declick, _declip, _hum_removal, _silence_trim,
        _tempo, _pitch, _reverse,
        _echo, _reverb, _chorus, _flanger, _phaser, _stereo_widen, _mono,
    ]
}


@lru_cache(maxsize=1)
def _available_filters() -> frozenset[str]:
    """Filter names this ffmpeg build actually supports."""
    try:
        out = _run([config.FFMPEG, "-hide_banner", "-filters"])
    except Exception:  # noqa: BLE001 - no ffmpeg at all; every effect hides
        return frozenset()
    names = set()
    for line in out.splitlines():
        match = re.match(r"^\s*[TSC.]{3}\s+(\S+)\s", line)
        if match:
            names.add(match.group(1))
    return frozenset(names)


def available_effects() -> list[EffectSpec]:
    """The subset of the registry this machine's ffmpeg can actually run."""
    filters = _available_filters()
    if not filters:
        return list(REGISTRY.values())  # detection failed open; build() will surface real errors
    return [spec for spec in REGISTRY.values() if all(f in filters for f in spec.requires)]


def build_chain(instances: list[dict[str, Any]]) -> str:
    """Turn a list of `{type, params, enabled}` dicts into one filter fragment."""
    fragments: list[str] = []
    for inst in instances:
        if not inst.get("enabled", True):
            continue
        spec = REGISTRY.get(inst["type"])
        if spec is None:
            log.warning("unknown effect type %r — skipped", inst.get("type"))
            continue
        fragments.append(spec.build(_values(spec, inst.get("params") or {})))
    return ",".join(fragments)
