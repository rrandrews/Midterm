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
  if (import.meta.env.DEV) {
    // Dev-only handles for poking at the app from the console or a test driver.
    const [actions, dock, store, sessions] = await Promise.all([
      import("./actions"),
      import("./layout/dock"),
      import("./state/store"),
      import("./terminal/sessions"),
    ]);
    Object.assign(window, { __midterm: { actions, dock, store, sessions } });
    if (new URLSearchParams(location.search).has("mockup")) {
      (await import("./dev/seed")).seedMockupLayout();
    }
  }
  await fontsReady();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

start();
