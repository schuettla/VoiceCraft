import { useEffect } from "react";
import { toast } from "sonner";
import { isTauri, openExternal } from "../lib/tauri";
import {
  alreadyNotified,
  autoCheckDue,
  checkForUpdate,
  markChecked,
  markNotified,
} from "../lib/updates";

/**
 * Renders nothing. Once the app is up it checks (at most daily) whether a newer
 * release exists and, if so, shows one toast per version with a link to it.
 * Failures are silent here — being offline must never nag; the Settings page has
 * a manual check that reports errors.
 */
export function UpdateNotifier() {
  useEffect(() => {
    if (!isTauri() || !autoCheckDue()) return;
    let cancelled = false;
    checkForUpdate()
      .then((info) => {
        if (cancelled) return;
        markChecked();
        if (!info.newer || alreadyNotified(info.latest)) return;
        markNotified(info.latest);
        toast(`VoiceCraft ${info.latest} is available`, {
          description: `You have ${info.current}.`,
          duration: 20_000,
          action: {
            label: "Download",
            onClick: () => void openExternal(info.url).catch(() => {}),
          },
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
