"""Compiles a `ProjectData` timeline into one ffmpeg filter graph.

Pure and DB-free: it knows nothing about generations, assets, or the
database. The caller (`services.edit_service`) resolves every clip's
`SourceRef` to a file path and a probed duration, and this module turns the
tracks/clips/intro/outro/master description into `-i` inputs plus a
`filter_complex` script that produces one `[out]` stream.

Layout convention: the intro sits at t=0. The body's own clip positions are
authored relative to a "body origin", which this module shifts by
`intro_len - intro_crossfade` so the intro can overlap the start of the body
by fading out under it (rather than a hard cut). The outro is placed so it
starts `outro_crossfade` seconds before the body ends, and fades in over that
overlap. Because everything is ultimately mixed (not concatenated), a
crossfade is just two overlapping fades summed by `amix` — there is no need
for ffmpeg's `acrossfade`, which only handles two linear inputs anyway.
"""

from __future__ import annotations

from dataclasses import dataclass

import effects
from models import ProjectData, SourceRef, Track


class TimelineError(ValueError):
    """A project that can't be compiled — surfaced as a 400."""


def source_key(ref: SourceRef) -> str:
    """Same `"g:<id>"` / `"a:<id>"` convention the frontend uses for clip keys."""
    return f"g:{ref.generation_id}" if ref.generation_id else f"a:{ref.asset_id}"


def required_sources(data: ProjectData) -> list[str]:
    """Every source key the project touches, in a stable order."""
    keys: list[str] = []
    if data.intro.asset_id:
        keys.append(f"a:{data.intro.asset_id}")
    if data.outro.asset_id:
        keys.append(f"a:{data.outro.asset_id}")
    for clip in data.clips:
        keys.append(source_key(clip.source))
    return list(dict.fromkeys(keys))


@dataclass
class CompiledGraph:
    source_keys: list[str]      # source_key -> input index is this list's position
    filter_script: str          # the whole -filter_complex_script content
    duration: float             # estimated output length, seconds


SAMPLE_RATE = 48000


def _fade_filters(clip_len: float, fade_in: float, fade_out: float) -> list[str]:
    parts = []
    if fade_in > 0:
        parts.append(f"afade=t=in:st=0:d={min(fade_in, clip_len):.3f}")
    if fade_out > 0 and clip_len > 0:
        start = max(0.0, clip_len - fade_out)
        parts.append(f"afade=t=out:st={start:.3f}:d={min(fade_out, clip_len):.3f}")
    return parts


def _pan_filter(pan: float) -> str | None:
    if abs(pan) < 1e-6:
        return None
    left = min(1.0, 1.0 - max(0.0, pan))
    right = min(1.0, 1.0 + min(0.0, pan))
    return f"pan=stereo|c0=c0*{left:.3f}|c1=c1*{right:.3f}"


def compile_timeline(
    data: ProjectData,
    durations: dict[str, float],
    loudnorm_measured: dict[str, float | None] | None = None,
) -> CompiledGraph:
    """`durations` must map every key from `required_sources()` to a duration
    in seconds (probed with `utils.audio.probe_duration`).

    Two-pass loudness normalization (`data.master.loudness.enabled`) needs the
    premaster mix's own measured stats before it can hit the target accurately
    (single-pass `loudnorm` only estimates them from the first few seconds).
    `loudnorm_measured=None` compiles a "pass 1" graph with no `loudnorm` and
    no safety limiter at all — nothing should shape the signal before it's
    measured — for the caller to render and feed through
    `utils.audio.measure_loudness`. Passing that measurement back in compiles
    the real "pass 2" graph, with `loudnorm` corrected by the exact
    `measured_*` stats (`linear=true`) followed by the usual safety limiter.
    """
    keys = required_sources(data)
    index_of = {key: i for i, key in enumerate(keys)}

    def dur(key: str) -> float:
        value = durations.get(key)
        if value is None:
            raise TimelineError(f"could not determine the length of {key}")
        return value

    statements: list[str] = []

    intro_len = dur(f"a:{data.intro.asset_id}") if data.intro.asset_id else 0.0
    intro_xfade = min(data.intro.crossfade_ms / 1000.0, intro_len) if data.intro.asset_id else 0.0
    body_offset = max(0.0, intro_len - intro_xfade)

    if data.intro.asset_id:
        idx = index_of[f"a:{data.intro.asset_id}"]
        chain = [
            f"[{idx}:a]atrim=0:{intro_len:.3f}",
            "asetpts=PTS-STARTPTS",
            f"aresample={SAMPLE_RATE}",
            "aformat=sample_fmts=fltp:channel_layouts=stereo",
            f"volume={data.intro.gain_db:.2f}dB",
        ]
        if intro_xfade > 0:
            chain.append(f"afade=t=out:st={intro_len - intro_xfade:.3f}:d={intro_xfade:.3f}")
        statements.append(",".join(chain) + "[intro]")

    # --- body: per-clip chains, grouped into per-track buses ---------------
    track_by_id: dict[str, Track] = {t.id: t for t in data.tracks}
    clip_labels_by_track: dict[str, list[str]] = {}
    body_end = body_offset

    for i, clip in enumerate(data.clips):
        if clip.muted:
            continue
        key = source_key(clip.source)
        idx = index_of[key]
        out_point = clip.out_point if clip.out_point is not None else dur(key)
        clip_len = max(0.0, out_point - clip.in_point)
        if clip_len <= 0:
            continue
        abs_start = body_offset + clip.start
        body_end = max(body_end, abs_start + clip_len)

        chain = [
            f"[{idx}:a]atrim={clip.in_point:.3f}:{out_point:.3f}",
            "asetpts=PTS-STARTPTS",
            f"aresample={SAMPLE_RATE}",
            "aformat=sample_fmts=fltp:channel_layouts=stereo",
        ]
        effect_chain = effects.build_chain([e.model_dump() for e in clip.effects])
        if effect_chain:
            chain.append(effect_chain)
        chain.append(f"volume={clip.gain_db:.2f}dB")
        chain.extend(_fade_filters(clip_len, clip.fade_in, clip.fade_out))
        start_ms = round(abs_start * 1000)
        if start_ms > 0:
            chain.append(f"adelay={start_ms}|{start_ms}")
        label = f"c{i}"
        statements.append(",".join(chain) + f"[{label}]")
        clip_labels_by_track.setdefault(clip.track_id, []).append(f"[{label}]")

    outro_len = dur(f"a:{data.outro.asset_id}") if data.outro.asset_id else 0.0
    outro_xfade = min(data.outro.crossfade_ms / 1000.0, outro_len) if data.outro.asset_id else 0.0
    outro_start = max(body_offset, body_end - outro_xfade) if data.outro.asset_id else body_end

    if data.outro.asset_id:
        idx = index_of[f"a:{data.outro.asset_id}"]
        chain = [
            f"[{idx}:a]atrim=0:{outro_len:.3f}",
            "asetpts=PTS-STARTPTS",
            f"aresample={SAMPLE_RATE}",
            "aformat=sample_fmts=fltp:channel_layouts=stereo",
            f"volume={data.outro.gain_db:.2f}dB",
        ]
        if outro_xfade > 0:
            chain.append(f"afade=t=in:st=0:d={outro_xfade:.3f}")
        start_ms = round(outro_start * 1000)
        if start_ms > 0:
            chain.append(f"adelay={start_ms}|{start_ms}")
        statements.append(",".join(chain) + "[outro]")

    total_duration = max(intro_len, body_end, outro_start + outro_len)

    # --- tracks: mix each track's clips, apply track effects/gain/pan/duck -
    solo_active = any(t.solo for t in data.tracks)
    track_final_label: dict[str, str] = {}
    master_inputs: list[str] = ["[intro]"] if data.intro.asset_id else []

    for track in data.tracks:
        labels = clip_labels_by_track.get(track.id, [])
        if not labels or track.mute or (solo_active and not track.solo):
            continue
        mix = f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0" if len(labels) > 1 else None
        rest: list[str] = []
        effect_chain = effects.build_chain([e.model_dump() for e in track.effects])
        if effect_chain:
            rest.append(effect_chain)
        if abs(track.gain_db) > 1e-6:
            rest.append(f"volume={track.gain_db:.2f}dB")
        pan = _pan_filter(track.pan)
        if pan:
            rest.append(pan)

        label = f"t_{track.id}"
        if mix is not None:
            statement = mix + ("," + ",".join(rest) if rest else "") + f"[{label}]"
        elif rest:
            statement = labels[0] + ",".join(rest) + f"[{label}]"
        else:
            # Nothing to do — alias the clip bus directly as the track bus.
            statement = f"{labels[0]}anull[{label}]"
        statements.append(statement)
        track_final_label[track.id] = label

    # Ducking: sidechain-compress a track against one or more "key" tracks
    # (typically voice). Only tracks that survived mute/solo above participate.
    #
    # A key track's bus is consumed twice — once by the sidechain, once by
    # whatever else uses it (usually the master mix) — and ffmpeg's
    # sidechaincompress does not tolerate a fanned-out input pad the way most
    # filters do (verified against a live build: the graph fails to bind with
    # "matches no streams" once the same label feeds both). Splitting the
    # label explicitly with `asplit` avoids that, one dedicated copy per use.
    duck_ops = [
        (
            track.id,
            [tid for tid in track.duck.against_track_ids if tid in track_final_label and tid != track.id],
        )
        for track in data.tracks
        if track.id in track_final_label and track.duck.enabled and track.duck.against_track_ids
    ]
    duck_ops = [(tid, key_ids) for tid, key_ids in duck_ops if key_ids]

    key_uses_remaining: dict[str, int] = {}
    for _tid, key_ids in duck_ops:
        for key_tid in key_ids:
            key_uses_remaining[key_tid] = key_uses_remaining.get(key_tid, 0) + 1

    def _pad_to_total(label: str) -> str:
        """sidechaincompress ends its output as soon as EITHER input runs out
        (verified against a live build), so anything feeding it that might be
        shorter than the whole mix gets padded with silence up to it first."""
        padded = f"{label}_pad"
        statements.append(
            f"[{label}]apad,atrim=0:{total_duration:.3f},asetpts=PTS-STARTPTS[{padded}]"
        )
        return padded

    key_copies: dict[str, list[str]] = {}
    for key_tid, count in key_uses_remaining.items():
        original = track_final_label[key_tid]
        copies = [f"{original}_split{i}" for i in range(count + 1)]
        statements.append(f"[{original}]asplit={count + 1}" + "".join(f"[{c}]" for c in copies))
        track_final_label[key_tid] = copies[0]  # everything else keeps using this one
        key_copies[key_tid] = [_pad_to_total(c) for c in copies[1:]]

    for track_id, key_ids in duck_ops:
        base = _pad_to_total(track_final_label[track_id])
        key_refs = [f"[{key_copies[key_tid].pop()}]" for key_tid in key_ids]
        if len(key_refs) > 1:
            key_label = f"duckkey_{track_id}"
            statements.append(
                f"{''.join(key_refs)}amix=inputs={len(key_refs)}:normalize=0[{key_label}]"
            )
            key_ref = f"[{key_label}]"
        else:
            key_ref = key_refs[0]

        # `amount_db` is how far the track dips, not a compressor threshold —
        # sidechaincompress has no "max reduction" control, and a threshold of
        # -12 dBFS never triggers on speech (~-20 dBFS RMS). So: compress a copy
        # almost to silence whenever the key is audible, then blend it with the
        # dry signal at g / (1-g). Key active -> ~g (= amount_db); key silent ->
        # the copy is uncompressed and the blend sums back to unity.
        track = track_by_id[track_id]
        g = 10 ** (-abs(track.duck.amount_db) / 20)
        dry, wet = f"t_{track_id}_dry", f"t_{track_id}_wet"
        ducked = f"t_{track_id}_ducked"
        statements.append(f"[{base}]asplit=2[{dry}][{wet}]")
        statements.append(
            f"[{wet}]{key_ref}sidechaincompress=threshold=0.003:ratio=20:"
            f"attack={track.duck.attack_ms:.1f}:release={track.duck.release_ms:.1f}:"
            f"makeup=1,volume={1 - g:.5f}[{wet}_c]"
        )
        statements.append(f"[{dry}]volume={g:.5f}[{dry}_v]")
        statements.append(f"[{dry}_v][{wet}_c]amix=inputs=2:normalize=0[{ducked}]")
        track_final_label[track_id] = ducked

    for track in data.tracks:
        label = track_final_label.get(track.id)
        if label:
            master_inputs.append(f"[{label}]")

    if data.outro.asset_id:
        master_inputs.append("[outro]")

    if not master_inputs:
        raise TimelineError("the project has nothing to render — add a clip first")

    if len(master_inputs) > 1:
        statements.append(
            f"{''.join(master_inputs)}amix=inputs={len(master_inputs)}:normalize=0[premaster]"
        )
        premaster = "[premaster]"
    else:
        premaster = master_inputs[0]

    master_chain: list[str] = []
    master_effect_chain = effects.build_chain([e.model_dump() for e in data.master.effects])
    if master_effect_chain:
        master_chain.append(master_effect_chain)

    loudness_pass1 = data.master.loudness.enabled and loudnorm_measured is None
    if data.master.loudness.enabled and loudnorm_measured is not None:
        measured_i = loudnorm_measured.get("integrated_lufs")
        measured_tp = loudnorm_measured.get("true_peak_db")
        measured_lra = loudnorm_measured.get("loudness_range")
        measured_thresh = loudnorm_measured.get("threshold_db")
        if None in (measured_i, measured_tp, measured_lra, measured_thresh):
            # The pass-1 measurement failed (e.g. digital silence) — fall back
            # to plain single-pass loudnorm rather than feeding ffmpeg NaNs.
            master_chain.append(
                f"loudnorm=I={data.master.loudness.target_lufs:.1f}:"
                f"TP={data.master.loudness.true_peak:.1f}:LRA=11"
            )
        else:
            master_chain.append(
                f"loudnorm=I={data.master.loudness.target_lufs:.1f}:"
                f"TP={data.master.loudness.true_peak:.1f}:LRA=11:"
                f"measured_I={measured_i:.2f}:measured_TP={measured_tp:.2f}:"
                f"measured_LRA={measured_lra:.2f}:measured_thresh={measured_thresh:.2f}:"
                "linear=true"
            )

    if not loudness_pass1:
        # A gentle safety ceiling regardless of loudnorm — multiple mixed
        # sources can exceed 0 dBFS even after per-track gain staging. Skipped
        # only on the pass-1 measurement graph, which must see the raw mix.
        master_chain.append("alimiter=limit=0.98")

    if not master_chain:
        # The pass-1 measurement graph with no master effects: still need a
        # filter (not just a relabel) to bridge premaster -> [out].
        master_chain.append("anull")

    statements.append(f"{premaster}{','.join(master_chain)}[out]")

    return CompiledGraph(
        source_keys=keys,
        filter_script=";\n".join(statements) + "\n",
        duration=total_duration,
    )
