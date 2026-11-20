import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Calls `onChange` with whether the window is fullscreen, now and whenever
 * that changes. Returns a function that stops. Never fullscreen in a browser.
 */
export function watchFullscreen(onChange: (fullscreen: boolean) => void): () => void {
  if (!isTauri()) {
    onChange(false);
    return () => {};
  }
  const window = getCurrentWindow();
  let stopped = false;
  let last: boolean | undefined;
  const check = () =>
    window.isFullscreen().then(
      (fullscreen) => {
        if (stopped || fullscreen === last) return;
        last = fullscreen;
        onChange(fullscreen);
      },
      (error) => console.error("isFullscreen failed:", error),
    );
  void check();
  // Entering or leaving fullscreen always resizes the window.
  const unlisten = window.onResized(check);
  return () => {
    stopped = true;
    void unlisten.then((stop) => stop());
  };
}

/**
 * Asks `mayClose` before the window closes (its close button) or the app
 * quits (⌘Q, which the backend turns into a `quit-requested` event instead
 * of quitting). Returns a function that stops.
 *
 * On macOS the close button hides the app instead (`app_hide_on_close`):
 * nothing is lost, so nothing is asked. Saved state is flushed all the same.
 */
export function installCloseGuards(
  mayClose: (what: "window" | "app") => Promise<boolean>,
  onHide?: () => void,
): () => void {
  if (!isTauri()) return () => {};
  const window = getCurrentWindow();
  let busy = false;
  // A second ⌘Q (or close click) while the question is open is ignored.
  const ask = async (what: "window" | "app") => {
    if (busy) return false;
    busy = true;
    try {
      return await mayClose(what);
    } catch (error) {
      console.error("Close check failed:", error);
      return true;
    } finally {
      busy = false;
    }
  };

  const unlistenClose = window.onCloseRequested(async (event) => {
    // Always prevented; the window is destroyed below once closing is agreed.
    event.preventDefault();
    const hidden = await invoke<boolean>("app_hide_on_close").catch((error) => {
      console.error("app_hide_on_close failed:", error);
      return false;
    });
    if (hidden) {
      onHide?.();
      return;
    }
    if (await ask("window")) await window.destroy();
  });
  const unlistenQuit = listen("quit-requested", async () => {
    if (await ask("app")) await invoke("app_quit");
  });
  return () => {
    void unlistenClose.then((stop) => stop());
    void unlistenQuit.then((stop) => stop());
  };
}
