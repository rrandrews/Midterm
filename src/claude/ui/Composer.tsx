import {
  ArrowUp,
  ChevronDown,
  FilePen,
  Gauge,
  ListChecks,
  Paperclip,
  Shield,
  ShieldOff,
  Slash,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../../components/ui/Menu";
import { type CommandOption, commandList, findPaneCommand, hasFullList, isPaneCommand, type PaneCommand, rememberCommands } from "../commands";
import type { EffortLevel, ImageAttachment, ModelInfo, PermissionMode, SlashCommand } from "../protocol";
import { bypassAllowed, getDraft, getSession, interrupt, runningTasks, sendMessage, setDraft, setEffort, setModel, setPanel, setPermissionMode, useSession, warmUp } from "../store";
import { contextPercent, EFFORT_LABELS, FALLBACK_MODELS, levelOf, MODE_LABELS, modeCycle, modelLabel, nextMode } from "./format";
import { allowByEnter } from "./PermissionPrompt";

/*
 * The composer: a box with the message, pasted images as thumbnails, and a
 * bar below (attach, commands, the permission mode chip, model and effort,
 * running agents, context percent, Send / Stop). ⏎ sends, ⇧⏎ adds a line,
 * Esc interrupts, ⇧⇥ cycles the mode, ↑ in an empty box recalls earlier
 * messages. `/` at the start opens command completion above the box.
 */


const MODE_ICONS: Record<PermissionMode, typeof Shield> = {
  default: Shield,
  acceptEdits: FilePen,
  plan: ListChecks,
  bypassPermissions: ShieldOff,
  dontAsk: Shield,
  auto: Sparkles,
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function readImage(file: File): Promise<ImageAttachment | undefined> {
  if (!IMAGE_TYPES.has(file.type)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ mediaType: file.type as ImageAttachment["mediaType"], data: url.slice(url.indexOf(",") + 1) });
    };
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

/* Text put into a pane's composer from elsewhere (the empty state's starters). */
const inserters = new Map<string, (text: string) => void>();
export function insertIntoComposer(sessionKey: string, text: string): void {
  inserters.get(sessionKey)?.(text);
}

/** Options whose label or value starts with the query, then those that contain it. */
function rankOptions(options: CommandOption[], query: string): CommandOption[] {
  const q = query.trim().toLowerCase();
  const has = (option: CommandOption, test: (text: string) => boolean) => test(option.label.toLowerCase()) || test(option.value.toLowerCase());
  const starts = options.filter((option) => has(option, (text) => text.startsWith(q)));
  return [...starts, ...options.filter((option) => !starts.includes(option) && has(option, (text) => text.includes(q)))];
}

function rank<T extends SlashCommand>(commands: T[], query: string): T[] {
  const q = query.toLowerCase();
  const starts = commands.filter((command) => command.name.toLowerCase().startsWith(q) || command.aliases?.some((alias) => alias.toLowerCase().startsWith(q)));
  const contains = q ? commands.filter((command) => !starts.includes(command) && command.name.toLowerCase().includes(q)) : [];
  return [...starts, ...contains];
}

function ModelMenu({ sessionKey, models }: { sessionKey: string; models: ModelInfo[] }) {
  const model = useSession(sessionKey, (session) => session?.model);
  const resolved = useSession(sessionKey, (session) => session?.resolvedModel);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="cc-chip" title="Model">
          <span>{modelLabel(model, models, resolved)}</span>
          <ChevronDown size={10} className="text-fg-faint" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" side="top" className="cc-menu">
        {models.map((candidate) => (
          <MenuItem key={candidate.value} checked={candidate.value === (model ?? "default")} onSelect={() => void setModel(sessionKey, candidate.value === "default" ? undefined : candidate.value)}>
            {candidate.displayName}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

const STANDARD_EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The effort chip: the current model's levels (the standard ones until the
 * session reports its models), and "Model default" ("Auto" on the chip).
 * Hidden only for a model known not to take an effort.
 */
function EffortMenu({ sessionKey, models }: { sessionKey: string; models: ModelInfo[] }) {
  const model = useSession(sessionKey, (session) => session?.model);
  const effort = useSession(sessionKey, (session) => session?.effort);
  const current = models.find((candidate) => candidate.value === (model ?? "default"));
  if (current?.supportsEffort === false) return null;
  const levels = current?.supportedEffortLevels?.length ? current.supportedEffortLevels : STANDARD_EFFORTS;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="cc-chip" title="Reasoning effort">
          <Gauge size={11} className="text-fg-dim" />
          <span>{effort ? (EFFORT_LABELS[effort] ?? effort) : "Auto"}</span>
          <ChevronDown size={10} className="text-fg-faint" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" side="top" className="cc-menu cc-menu-narrow">
        <div className="cc-menu-label">Reasoning effort</div>
        {levels.map((level) => (
          <MenuItem key={level} checked={effort === level} onSelect={() => void setEffort(sessionKey, level)}>
            {EFFORT_LABELS[level] ?? level}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem checked={!effort} onSelect={() => void setEffort(sessionKey, null)}>
          Model default
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function Composer({ sessionKey, inputRef }: { sessionKey: string; inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const status = useSession(sessionKey, (session) => session?.status);
  const mode = useSession(sessionKey, (session) => session?.permissionMode ?? "default");
  const canBypass = useSession(sessionKey, (session) => (session ? bypassAllowed(session) : false));
  const init = useSession(sessionKey, (session) => session?.init);
  const cwd = useSession(sessionKey, (session) => session?.cwd ?? "");
  const choice = useSession(sessionKey, (session) => `${session?.model ?? ""}|${session?.effort ?? ""}`);
  const agents = useSession(sessionKey, (session) => (session ? runningTasks(session) : 0));
  const percent = useSession(sessionKey, (session) => contextPercent(session?.contextTokens, session?.context?.maxTokens || session?.contextWindow));
  // The draft outlives the component (tab switches): read on mount, saved as it changes.
  const [text, setText] = useState(() => getDraft(sessionKey)?.text ?? "");
  const [images, setImages] = useState<ImageAttachment[]>(() => getDraft(sessionKey)?.images ?? []);
  useEffect(() => setDraft(sessionKey, { text, images }), [sessionKey, text, images]);
  const loading = useSession(sessionKey, (session) => session?.loadingTranscript === true);
  const [selected, setSelected] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const history = useRef<{ index: number; draft: string } | undefined>(undefined);
  const file = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const running = status === "running";
  const models = init?.models.length ? init.models : FALLBACK_MODELS;

  useEffect(() => {
    inserters.set(sessionKey, (value) => {
      setText(value);
      setMenuClosed(false);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        input?.focus();
        input?.setSelectionRange(value.length, value.length);
      });
    });
    return () => {
      inserters.delete(sessionKey);
    };
  }, [sessionKey, inputRef]);

  // `/na…`: commands. `/model so…`: the argument's choices, for a pane command that has them.
  const slash = /^\/(\S*)$/.exec(text);
  const argument = /^\/(\S+) ([^\n]*)$/.exec(text);
  const optionsFor = argument ? findPaneCommand(`/${argument[1]}`)?.command : undefined;
  const commands = useMemo(() => commandList({ init, cwd }), [init, cwd]);
  const matches = useMemo(() => (slash ? rank(commands, slash[1]).slice(0, 300) : []), [slash?.[1], commands]);
  const options = useMemo(() => {
    const session = getSession(sessionKey);
    return optionsFor?.options && session && argument ? rankOptions(optionsFor.options(session), argument[2]) : [];
  }, [optionsFor, argument?.[2], sessionKey, init, choice]);
  const count = slash ? matches.length : options.length;
  const fullList = hasFullList({ init, cwd });
  const menuOpen = !menuClosed && (slash ? matches.length > 0 : options.length > 0);
  const active = Math.min(selected, Math.max(0, count - 1));

  useEffect(() => setSelected(0), [slash?.[1], argument?.[2]]);
  // The CLI's own list (skills, plugin commands) comes from its process: start it when the menu opens.
  useEffect(() => {
    if (slash) warmUp(sessionKey);
  }, [Boolean(slash), sessionKey]);
  useEffect(() => {
    if (init?.commands.length) rememberCommands(cwd, init.commands);
  }, [init?.commands, cwd]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /** Runs a command the pane answers itself; `false` when `value` is not one. */
  const runPaneCommand = (value: string): boolean => {
    const found = findPaneCommand(value);
    if (!found) return false;
    // While a restored transcript loads, commands wait like messages (the text stays).
    if (loading) return true;
    const { command, args } = found;
    if (command.options && !args.trim()) {
      // Bare `/model`: list the choices.
      setText(`/${command.name} `);
      setMenuClosed(false);
      return true;
    }
    runCommand(command, args, value);
    return true;
  };

  const runCommand = (command: PaneCommand, args: string, typed: string) => {
    setText("");
    // Cleared now, not by the effect after render: a command that replaces the session (/clear) would carry it over.
    setDraft(sessionKey, { text: "", images });
    history.current = undefined;
    void Promise.resolve(
      command.run(sessionKey, args, {
        send: (message) => send(message),
        restore: () => setText((current) => (current === "" ? typed : current)),
      }),
    );
  };

  const send = (value = text) => {
    if (runPaneCommand(value)) return;
    // While a restored transcript loads nothing is sent: the draft stays (the placeholder says why).
    if ((!value.trim() && images.length === 0) || loading) return;
    const sent = images;
    void sendMessage(sessionKey, value, sent).then((ok) => {
      // Not sent (a mode change it waited for was refused): back in the box, unless something new was typed.
      if (ok) return;
      if (!getDraft(sessionKey)) setDraft(sessionKey, { text: value, images: sent });
      setText((current) => (current === "" ? value : current));
      setImages((current) => (current.length === 0 ? sent : current));
    });
    setText("");
    setImages([]);
    history.current = undefined;
  };

  const pick = (command: SlashCommand | PaneCommand, run: boolean) => {
    const value = `/${command.name}${command.argumentHint || !run ? " " : ""}`;
    if (isPaneCommand(command) && command.options) {
      setText(`/${command.name} `);
      setMenuClosed(false);
    } else if (run && !command.argumentHint) send(value.trim());
    else {
      setText(value);
      setMenuClosed(true);
    }
  };

  const pickOption = (option: CommandOption) => {
    if (!optionsFor || loading) return;
    runCommand(optionsFor, option.value, `/${optionsFor.name} ${option.value}`);
  };

  const userTexts = () => (getSession(sessionKey)?.items ?? []).flatMap((item) => (item.kind === "user" && item.text ? [item.text] : []));

  const recall = (direction: -1 | 1): boolean => {
    const past = userTexts();
    if (!past.length) return false;
    const state = history.current ?? { index: past.length, draft: text };
    const index = Math.min(past.length, Math.max(0, state.index + direction));
    if (index === state.index) return false;
    history.current = { index, draft: state.draft };
    setText(index === past.length ? state.draft : past[index]);
    return true;
  };

  const cycleMode = () => void setPermissionMode(sessionKey, nextMode(mode, canBypass));

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((active + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
        return;
      }
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        if (slash) pick(matches[active], false);
        else setText(`/${argument?.[1]} ${options[active].value}`);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (slash) pick(matches[active], true);
        else pickOption(options[active]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuClosed(true);
        return;
      }
    }
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      cycleMode();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!text.trim() && images.length === 0) {
        const prompt = getSession(sessionKey)?.permissions[0];
        if (prompt) allowByEnter(sessionKey, prompt);
        return;
      }
      send();
    } else if (event.key === "Escape" && running) {
      event.preventDefault();
      void interrupt(sessionKey);
    } else if (event.key === "ArrowUp" && (text === "" || history.current) && !text.slice(0, event.currentTarget.selectionStart).includes("\n")) {
      if (recall(-1)) event.preventDefault();
    } else if (event.key === "ArrowDown" && history.current && !text.slice(event.currentTarget.selectionEnd).includes("\n")) {
      if (recall(1)) event.preventDefault();
    }
  };

  const addFiles = async (files: Iterable<File>) => {
    const read = (await Promise.all([...files].map(readImage))).filter((image): image is ImageAttachment => image !== undefined);
    if (read.length) setImages((current) => [...current, ...read]);
  };

  const onPaste = (event: ClipboardEvent) => {
    const files = [...event.clipboardData.files].filter((candidate) => IMAGE_TYPES.has(candidate.type));
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  };
  const onDrop = (event: DragEvent) => {
    setDragging(false);
    const files = [...event.dataTransfer.files].filter((candidate) => IMAGE_TYPES.has(candidate.type));
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  };

  const ModeIcon = MODE_ICONS[mode];
  const allowedModes = modeCycle(canBypass);
  const canSend = (text.trim() !== "" || images.length > 0) && !loading;

  return (
    <div className="cc-composer-wrap">
      {menuOpen && (
        <div ref={list} className="cc-slash" role="listbox" aria-label="Commands">
          {slash
            ? matches.map((command, index) => (
                <div
                  key={`${command.name}:${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === active}
                  className={`cc-slash-item${index === active ? " is-active" : ""}`}
                  onMouseEnter={() => setSelected(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(command, true);
                  }}
                >
                  <span className="cc-slash-name">/{command.name}</span>
                  {command.argumentHint && <span className="cc-slash-hint">{command.argumentHint}</span>}
                  <span className="cc-slash-desc">{command.description}</span>
                </div>
              ))
            : options.map((option, index) => (
                <div
                  key={option.value}
                  data-index={index}
                  role="option"
                  aria-selected={index === active}
                  className={`cc-slash-item${index === active ? " is-active" : ""}`}
                  onMouseEnter={() => setSelected(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pickOption(option);
                  }}
                >
                  <span className="cc-slash-name is-option">{option.label}</span>
                  {option.label.toLowerCase() !== option.value.toLowerCase() && <span className="cc-slash-hint">{option.value}</span>}
                  {option.current && <span className="cc-slash-desc cc-slash-current">current</span>}
                </div>
              ))}
          {slash && !fullList && status === "starting" && <div className="cc-slash-loading">Loading Claude Code's commands…</div>}
        </div>
      )}
      <div
        className={`cc-composer${dragging ? " is-dragging" : ""}`}
        onDragOver={(event) => {
          if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {images.length > 0 && (
          <div className="cc-attachments">
            {images.map((image, index) => (
              <span key={index} className="cc-attachment">
                <img src={`data:${image.mediaType};base64,${image.data}`} alt="" className="cc-thumb" />
                <button type="button" className="cc-attachment-remove" aria-label="Remove image" onClick={() => setImages(images.filter((_, other) => other !== index))}>
                  <X size={9} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          className="cc-input"
          placeholder={loading ? "Loading the transcript…" : running ? "Queue another message…" : "Message Claude…"}
          aria-label="Message Claude"
          spellCheck
          onChange={(event) => {
            setText(event.target.value);
            setMenuClosed(false);
            history.current = undefined;
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="cc-bar">
          <button type="button" className="cc-icon-button" title="Attach images" aria-label="Attach images" onClick={() => file.current?.click()}>
            <Paperclip size={12} />
          </button>
          <button
            type="button"
            className="cc-icon-button"
            title="Commands"
            aria-label="Commands"
            onClick={() => {
              setText("/");
              setMenuClosed(false);
              inputRef.current?.focus();
            }}
          >
            <Slash size={12} />
          </button>
          <Menu>
            <MenuTrigger asChild>
              <button type="button" className={`cc-chip cc-mode is-${mode}`} title="Permission mode (⇧⇥ cycles)">
                <ModeIcon size={11} />
                <span>{MODE_LABELS[mode]}</span>
              </button>
            </MenuTrigger>
            <MenuContent align="start" side="top" className="cc-menu">
              {allowedModes.map((candidate) => {
                const Icon = MODE_ICONS[candidate];
                return (
                  <MenuItem key={candidate} checked={mode === candidate} onSelect={() => void setPermissionMode(sessionKey, candidate)}>
                    <span className={`cc-menu-mode is-${candidate}`}>
                      <Icon size={12} />
                      {MODE_LABELS[candidate]}
                    </span>
                  </MenuItem>
                );
              })}
              <div className="cc-menu-foot">⇧⇥ cycles modes</div>
            </MenuContent>
          </Menu>
          <ModelMenu sessionKey={sessionKey} models={models} />
          <EffortMenu sessionKey={sessionKey} models={models} />
          {agents > 0 && (
            <button type="button" className="cc-chip" title="Running agents" onClick={() => setPanel(sessionKey, "agents")}>
              <span className="cc-live-dot" />
              <span>
                {agents} agent{agents === 1 ? "" : "s"}
              </span>
            </button>
          )}
          <span className="cc-bar-spacer" />
          {percent !== undefined && (
            <button type="button" className={`cc-bar-context cc-num${percent > 70 ? ` text-${levelOf(percent)}` : ""}`} title="Context used: open the breakdown" onClick={() => setPanel(sessionKey, "context")}>
              {percent}%
            </button>
          )}
          {running && !canSend ? (
            <button type="button" className="cc-send is-stop" title="Stop (Esc)" aria-label="Stop" onClick={() => void interrupt(sessionKey)}>
              <Square size={9} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="cc-send" title={running ? "Queue (⏎)" : "Send (⏎)"} aria-label="Send" disabled={!canSend} onClick={() => send()}>
              <ArrowUp size={13} />
            </button>
          )}
        </div>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) void addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
