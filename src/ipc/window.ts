import { isTauri } from "@tauri-apps/api/core";
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
