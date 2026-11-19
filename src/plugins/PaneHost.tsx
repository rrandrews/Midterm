import { Component, type CSSProperties, type ErrorInfo, type ReactNode, memo, useEffect, useMemo, useRef } from "react";
import { focusPane, notePaneFocused, registerPaneFocuser } from "../layout/dock";
import { closePane } from "../closing";
import { registerPaneActions } from "../commands/registry";
import { selectActiveTab, useAppStore } from "../state/store";
import type { PaneData, PaneNode } from "../state/types";
import { livePane, updatePaneData } from "../actions";
import { PaneMenuItems } from "../components/layout/PaneMenuItems";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, MenuSeparator } from "../components/ui/Menu";
import { MenuItems } from "./MenuItems";
import { PluginPlaceholder } from "./PluginPlaceholder";
import { activePlugin, apiOf, getPlugin, loadErrorOf, usePluginsVersion } from "./registry";
import type { MenuItemSpec, PaneContext, PanePlugin } from "./types";

/*
 * Hosts a pane's content: looks up the plugin for its kind and renders its
 * component (or mounts it into an element), inside an error boundary of its
 * own. Tracks whether it is the active pane and gives it a right-click
 * menu: the plugin's items, then the items every pane has. A pane whose
 * plugin is missing or disabled shows a placeholder.
 */

/** The context handed to a plugin for one pane. */
export function createPaneContext(paneId: string, pluginId: string): PaneContext {
  return {
    paneId,
    data: () => livePane(paneId)?.data ?? ({ kind: pluginId } as PaneData),
    updateData: (patch) => updatePaneData(paneId, patch),
    onFocusRequest: (focus) => registerPaneFocuser(paneId, focus),
    registerActions: (actions) => registerPaneActions(paneId, actions),
    focus: () => focusPane(paneId),
    close: () => void closePane(paneId),
    get api() {
      const api = apiOf(pluginId);
      if (!api) throw new Error("The plugin host is not installed");
      return api;
    },
  };
}

export const PaneHost = memo(function PaneHost({ pane }: { pane: PaneNode }) {
  usePluginsVersion();
  const { kind } = pane.data;
  const registered = getPlugin(kind);
  // An imported plugin whose code is not loaded (yet, or it failed) has nothing to render.
  const stub = registered?.source.type === "imported" && registered.source.stub;
  const plugin = stub ? undefined : activePlugin(kind);
  const problem = stub && activePlugin(kind) ? (loadErrorOf(kind) ? `It failed to load: ${loadErrorOf(kind)}` : "Loading…") : undefined;
  const active = useAppStore((state) => selectActiveTab(state).activePaneId === pane.id);
  const ctx = useMemo(() => createPaneContext(pane.id, kind), [pane.id, kind]);
  const activate = () => {
    notePaneFocused(pane.id);
    useAppStore.getState().setActivePane(pane.id);
  };
  const spec = plugin?.pane;
  const style = {
    ...(spec?.background && { "--pane-bg": spec.background }),
    ...(spec?.activeBackground && { "--pane-bg-active": spec.activeBackground }),
  } as CSSProperties;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={`pane pane-${kind}${active ? " is-active" : ""}`}
          style={style}
          data-pane-id={pane.id}
          data-pane-kind={kind}
          // The pane becomes active when anything inside it is focused or pressed.
          onFocusCapture={activate}
          onPointerDownCapture={activate}
          onContextMenu={(event) => {
            // Content that handles right clicks itself (a terminal program
            // reading the mouse) gets them; preventing the default also
            // stops the menu opening.
            if (spec?.ownsContextMenu?.(pane.id, event.nativeEvent)) event.preventDefault();
          }}
        >
          {plugin ? (
            <PaneErrorBoundary key={kind} name={plugin.name}>
              <PluginContent plugin={plugin} pane={pane} active={active} ctx={ctx} />
            </PaneErrorBoundary>
          ) : (
            <PluginPlaceholder paneId={pane.id} kind={kind} problem={problem} />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Pane">
        {plugin && <PluginMenuItems plugin={plugin} ctx={ctx} />}
        <PaneMenuItems paneId={pane.id} />
      </ContextMenuContent>
    </ContextMenu>
  );
});

function PluginContent({ plugin, pane, active, ctx }: { plugin: PanePlugin; pane: PaneNode; active: boolean; ctx: PaneContext }) {
  const { component: Content, mount } = plugin.pane;
  if (Content) return <Content paneId={pane.id} data={pane.data} active={active} ctx={ctx} />;
  if (mount) return <MountedContent mount={mount} ctx={ctx} />;
  return <PluginPlaceholder paneId={pane.id} kind={pane.data.kind} problem="This plugin has nothing to show." />;
}

/** A framework-free plugin pane: `mount` renders into an element and returns its cleanup. */
function MountedContent({ mount, ctx }: { mount: NonNullable<PanePlugin["pane"]["mount"]>; ctx: PaneContext }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Focusable by default, so the pane can take the keyboard.
    const unregister = ctx.onFocusRequest(() => el.focus({ preventScroll: true }));
    let cleanup: (() => void) | undefined;
    try {
      const result = mount(el, ctx);
      cleanup = typeof result === "function" ? result : undefined;
    } catch (error) {
      console.error(`Pane plugin failed to mount:`, error);
      el.textContent = `This pane failed to open: ${error instanceof Error ? error.message : String(error)}`;
    }
    return () => {
      unregister();
      try {
        cleanup?.();
      } catch (error) {
        console.error("Pane plugin failed to unmount:", error);
      }
      el.replaceChildren();
    };
  }, [mount, ctx]);
  return <div ref={ref} tabIndex={-1} className="h-full w-full overflow-auto outline-none" />;
}

/** The plugin's right-click items, with a separator after them. */
function PluginMenuItems({ plugin, ctx }: { plugin: PanePlugin; ctx: PaneContext }) {
  let items: MenuItemSpec[] = [];
  try {
    items = plugin.pane.menu?.(ctx) ?? [];
  } catch (error) {
    console.error(`The ${plugin.id} plugin's menu failed:`, error);
  }
  if (items.length === 0) return null;
  return (
    <>
      <MenuItems items={items} />
      <MenuSeparator />
    </>
  );
}

type BoundaryState = { error: Error | null };

/** Keeps a failing pane from taking the app down: it shows the error instead. */
class PaneErrorBoundary extends Component<{ name: string; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`The ${this.props.name} pane failed:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <div className="font-medium text-fg-mid">The {this.props.name} pane failed</div>
        <div className="max-w-full truncate text-meta text-fg-dim" title={error.message}>
          {error.message}
        </div>
        <button
          type="button"
          className="h-6 rounded-[5px] bg-raised px-2.5 text-meta text-fg-soft hover:text-fg-bright"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </div>
    );
  }
}
