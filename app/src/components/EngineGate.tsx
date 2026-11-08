import type { ReactNode } from "react";
import type { AudioEngine } from "../lib/types";
import { formatBytes } from "../lib/format";
import { HfTokenField } from "./HfTokenField";
import { Notice } from "./common";
import { Button } from "@/components/ui/button";

/**
 * Between a mode's tab and its form: until the engine is installed, supported
 * and has its weights, show one card that says what is missing and where to get
 * it, instead of a form whose Generate button can only fail. `children` renders
 * once the engine is ready.
 *
 * `engine` is the default engine of the mode's kind as `/api/audio-engines`
 * reports it (null while that call is in flight or when the backend doesn't know
 * of one).
 */
export function EngineGate<E extends AudioEngine>({
  engine,
  passedOver = null,
  loading,
  subject,
  noun,
  plural = false,
  lead = null,
  onOpenModels,
  children,
}: {
  engine: E | null;
  /**
   * The kind's usual engine, when this machine can't run it and `engine` is the
   * lighter one offered instead (ACE-Step on a PC without an NVIDIA GPU).
   */
  passedOver?: AudioEngine | null;
  loading: boolean;
  /** The Models page section and the card titles: "Sound effects", "Music generation". */
  subject: string;
  /** Lower-case, for running text: "sound-effect", "music". */
  noun: string;
  /** "Sound effects aren't installed", but "Music generation isn't". */
  plural?: boolean;
  /** Why this engine is the one on offer, shown above whatever card is needed. */
  lead?: ReactNode;
  onOpenModels: () => void;
  children: (engine: E) => ReactNode;
}) {
  if (loading && !engine) {
    return <p className="py-8 text-sm text-muted-foreground">Checking {noun} engine…</p>;
  }
  if (!engine) {
    return (
      <Notice tone="bad">
        This version of the background engine has no {noun} support. Restart
        VoiceCraft; if that doesn't help, the app needs an update.
      </Notice>
    );
  }
  const size = engine.download_estimate_bytes
    ? ` (${formatBytes(engine.download_estimate_bytes)})`
    : "";
  if (!engine.supported) {
    return (
      <>
        {lead && <Notice tone="info" className="mb-3">{lead}</Notice>}
        <EngineCard engine={engine} title={`${subject} can't run on this machine`}>
          <p>{engine.unsupported_reason}</p>
        </EngineCard>
      </>
    );
  }
  // A gated model needs the user's Hugging Face token before it can download, so
  // the card carries the field instead of sending them to find it.
  const needsToken = engine.gated && !engine.model_downloaded;
  if (!engine.installed) {
    return (
      <>
      {lead && <Notice tone="info" className="mb-3">{lead}</Notice>}
      <EngineCard
        engine={engine}
        passedOver={passedOver}
        title={`${subject} ${plural ? "aren't" : "isn't"} installed yet`}
        action={
          <Button type="button" onClick={onOpenModels}>
            Install engine
          </Button>
        }
      >
        <p>
          Step 1 is the engine (its Python packages), step 2 the model files{size}.
          Both are on the Models page, under {subject}.
        </p>
        {needsToken && <GatedStep engine={engine} />}
      </EngineCard>
      </>
    );
  }
  if (!engine.model_downloaded) {
    return (
      <>
      {lead && <Notice tone="info" className="mb-3">{lead}</Notice>}
      <EngineCard
        engine={engine}
        passedOver={passedOver}
        title={`The ${noun} model isn't downloaded yet`}
        action={
          <Button type="button" onClick={onOpenModels}>
            Download model
          </Button>
        }
      >
        <p>
          The engine is installed. Download {engine.model_title ?? "the model"}
          {size} from the Models page, under {subject}.
        </p>
        {needsToken && <GatedStep engine={engine} />}
      </EngineCard>
      </>
    );
  }
  return <>{children(engine)}</>;
}

/** The gated-model part of an install card: what it is, and the token field. */
function GatedStep({ engine }: { engine: AudioEngine }) {
  return (
    <div className="space-y-2 rounded-md border px-3 py-3">
      <p>
        {engine.model_title ?? "This model"} is gated. Accept its terms on its
        Hugging Face page, then give VoiceCraft a read token:
      </p>
      <HfTokenField />
    </div>
  );
}

function EngineCard({
  engine,
  passedOver = null,
  title,
  children,
  action,
}: {
  engine: AudioEngine;
  passedOver?: AudioEngine | null;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-md border bg-card/40 px-4 py-4">
      <div>
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {engine.label}
          {engine.license_name ? ` · ${engine.license_name}` : ""}
        </p>
      </div>
      {passedOver && (
        <Notice tone="info">
          {passedOver.label} can't run on this machine
          {passedOver.unsupported_reason ? ` (${passedOver.unsupported_reason})` : ""}.{" "}
          {engine.label} can, so it is offered here instead.
        </Notice>
      )}
      <div className="space-y-2 text-[13px] leading-relaxed text-muted-foreground">
        {children}
      </div>
      {action}
    </div>
  );
}
