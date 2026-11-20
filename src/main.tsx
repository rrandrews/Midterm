import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/index.css";
import App from "./App";

/**
 * Terminals measure their cell size from the font when they open, so the
 * bundled fonts must be ready first. They are local files; the timeout only
 * guards against a load that never settles.
 */
async function fontsReady(): Promise<void> {
  const fonts = ['12.5px "JetBrains Mono Variable"', '12.5px "Inter Variable"'];
  await Promise.race([
    Promise.all(fonts.map((font) => document.fonts.load(font))),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]).catch((error) => console.warn("Font preload failed:", error));
}

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  // Dev seeds and self-tests use throwaway state that must not replace the saved one.
  const persist = !import.meta.env.DEV || !(params.has("mockup") || params.has("selftest"));
  // Plugins first: restoring validates each pane's data with its plugin.
  (await import("./plugins")).installPlugins();
  (await import("./theme/commands")).installThemeCommands();
  (await import("./ai/commands")).installAi();
  const { restoreSavedState, startSaving } = await import("./state/persistence");
  const { loadHomeDirectory, loadLocalHostname } = await import("./ipc/system");
  const { loadSettings } = await import("./settings/settings");
  const { loadRecent } = await import("./palette/sources");
  const { loadCustomThemes } = await import("./theme/state");
  const { loadIconSets } = await import("./icons/state");
  // All before any pane exists: restored terminals start in their saved
  // directories, directory reports are checked against the host name, and
  // explorers start in (and abbreviate) the home directory.
  await Promise.all([
    persist ? restoreSavedState() : undefined,
    loadSettings({ persist }),
    loadRecent({ persist }),
    loadCustomThemes({ persist }),
    loadIconSets({ persist }),
    loadLocalHostname(),
    loadHomeDirectory(),
  ]);
  if (import.meta.env.DEV) {
    // Dev-only handles for poking at the app from the console or a test driver.
    const [actions, dock, store, sessions, settings, commands, plugins, skills, loader] = await Promise.all([
      import("./actions"),
      import("./layout/dock"),
      import("./state/store"),
      import("./terminal/sessions"),
      import("./settings/settings"),
      import("./commands/registry"),
      import("./plugins/registry"),
      import("./plugins/skills"),
      import("./plugins/loader"),
    ]);
    Object.assign(window, {
      __midterm: {
        actions,
        dock,
        store,
        sessions,
        settings,
        commands,
        plugins,
        skills,
        loader,
        invokeSkillTool: skills.invokeSkillTool,
      },
    });
    if (params.has("mockup")) (await import("./dev/seed")).seedMockupLayout();
    const selfTestPort = params.get("selftest");
    if (selfTestPort) void import("./dev/selftest").then((m) => m.runSelfTest(selfTestPort));
  }
  if (persist) startSaving();
  (await import("./settings/apply")).installSettingsStyles();
  // Before the first render, so nothing shows in the wrong colors.
  (await import("./theme/apply")).installThemes();
  await fontsReady();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  // Imported plugins load after the first render: a slow or broken one never delays the app.
  void (await import("./plugins/loader")).loadImportedPlugins();
}

start();
