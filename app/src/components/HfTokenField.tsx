import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { HfTokenStatus } from "../lib/types";
import { ExternalLink } from "./ExternalLink";
import { useToast } from "./Toaster";
import { Badge } from "./common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const TOKENS_URL = "https://huggingface.co/settings/tokens";

/**
 * The Hugging Face token that gated downloads (Stable Audio 3) need.
 *
 * Write-only by design: the backend says whether a token exists and where it
 * came from, never what it is, so after saving there is nothing here to show or
 * copy. A token from the user's own Hugging Face login counts too, and is left
 * alone (it can't be removed from here).
 */
export function HfTokenField({ onChange }: { onChange?: (status: HfTokenStatus) => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<HfTokenStatus | null>(null);
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);

  const apply = useCallback(
    (next: HfTokenStatus) => {
      setStatus(next);
      onChange?.(next);
    },
    [onChange],
  );

  useEffect(() => {
    let current = true;
    api
      .hfTokenStatus()
      .then((next) => current && apply(next))
      .catch(() => current && setStatus({ configured: false, source: null }));
    return () => {
      current = false;
    };
  }, [apply]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    try {
      apply(await api.saveHfToken(token.trim()));
      setToken("");
      setReplacing(false);
      toast("Hugging Face token saved", "success");
    } catch (caught) {
      toast((caught as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      apply(await api.clearHfToken());
      toast("Hugging Face token removed", "success");
    } catch (caught) {
      toast((caught as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <p className="text-xs text-muted-foreground">Checking…</p>;

  const showForm = !status.configured || replacing;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        {status.configured ? (
          <>
            <Badge tone="good">token ready</Badge>
            <span className="text-muted-foreground">
              {status.source === "app"
                ? "Saved in VoiceCraft's data folder."
                : "Using the token from your Hugging Face login."}
            </span>
            <span className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setReplacing((current) => !current)}
              >
                {replacing ? "Cancel" : "Replace"}
              </Button>
              {status.source === "app" && (
                <Button size="sm" variant="outline" disabled={busy} onClick={remove}>
                  Remove
                </Button>
              )}
            </span>
          </>
        ) : (
          <>
            <Badge tone="warn">no token</Badge>
            <span className="text-muted-foreground">
              Needed once, to download models Stability AI gates.
            </span>
          </>
        )}
      </div>

      {showForm && (
        <form onSubmit={save} autoComplete="off" className="flex gap-2">
          <Input
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            placeholder="hf_…"
            aria-label="Hugging Face access token"
            onChange={(event) => setToken(event.target.value)}
          />
          <Button type="submit" disabled={busy || !token.trim()}>
            Save token
          </Button>
        </form>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Sign in at huggingface.co, open each gated model's page and accept its terms,
        then create a <strong className="font-medium text-foreground">read</strong>{" "}
        token at <ExternalLink href={TOKENS_URL} className="text-muted-foreground" />.
        VoiceCraft uses it only for these downloads and keeps it in its own data
        folder, not in the library or the settings file.
      </p>
    </div>
  );
}
