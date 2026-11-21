import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import fuzzysort from "fuzzysort";
import {
  ArrowUp,
  AtSign,
  ChevronDown,
  FilePen,
  FileText,
  Gauge,
  ListChecks,
  MoreHorizontal,
  Paperclip,
  Shield,
  ShieldOff,
  Slash,
  Square,
  X,
} from "lucide-react";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../../components/ui/Menu";
import { findFiles } from "../../ipc/fs";
import {
  type CommandOption,
  commandList,
  findPaneCommand,
  type ListedCommand,
  type PaneCommand,
  rememberCommands,
} from "../commands";
import {
  cycleMode,
  getDraft,
  getSession,
  interrupt,
  sendMessage,
  setConfigValue,
  setDraft,
  setModeValue,
  setPanel,
  useSession,
  warmUp,
} from "../store";
import type { FileMention, ImageAttachment } from "../types";
import {
  contextPercent,
  findConfigOption,
  flattenSelectOptions,
  isGroupedOptions,
  levelOf,
  modeTone,
  selectCurrentLabel,
} from "./format";
import { allowPermissionByEnter } from "./PermissionPrompt";

/*
 * Composer: auto-growing textarea with `/` command completion, `@` file
 * mention completion (ACP `resource_link`), capability-gated image attach/drop,
 * dynamic ACP `configOptions` chips (Mode, Model, Thinking, plus an overflow
 * menu for extra boolean/select options), and Send / Stop.
 */

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

const inserters = new Map<string, (text: string) => void>();
export function insertIntoComposer(sessionKey: string, text: string): void {
  inserters.get(sessionKey)?.(text);
}

const restorers = new Map<string, (draft: { text: string; images: ImageAttachment[]; mentions: FileMention[] }) => void>();
export function restoreDraftIntoComposer(
  sessionKey: string,
  draft: { text: string; images: ImageAttachment[]; mentions: FileMention[] },
): void {
  const fn = restorers.get(sessionKey);
  if (fn) {
    fn(draft);
    return;
  }
  const existing = getDraft(sessionKey);
  setDraft(sessionKey, {
    text: existing?.text ? `${existing.text}\n${draft.text}`.trim() : draft.text,
    images: [...(existing?.images ?? []), ...draft.images],
    mentions: [...(existing?.mentions ?? []), ...draft.mentions.filter((m) => !(existing?.mentions ?? []).some((e) => e.path === m.path))],
  });
}

/** Short-lived cache of workspace files for `@` autocomplete. */
const fileCache = new Map<string, { paths: string[]; fetchedAt: number }>();
const FILE_CACHE_TTL = 15_000;

async function workspaceFiles(cwd: string): Promise<string[]> {
  const cached = fileCache.get(cwd);
  if (cached && Date.now() - cached.fetchedAt < FILE_CACHE_TTL) return cached.paths;
  try {
    const found = await findFiles(cwd, 4000);
    fileCache.set(cwd, { paths: found.paths, fetchedAt: Date.now() });
    return found.paths;
  } catch {
    return cached?.paths ?? [];
  }
}

function rankCommands(commands: ListedCommand[], query: string): ListedCommand[] {
  const q = query.toLowerCase();
  const starts = commands.filter(
    (cmd) => cmd.name.toLowerCase().startsWith(q) || cmd.aliases?.some((a) => a.toLowerCase().startsWith(q)),
  );
  const contains = q ? commands.filter((cmd) => !starts.includes(cmd) && cmd.name.toLowerCase().includes(q)) : [];
  return [...starts, ...contains];
}

function rankOptions(options: CommandOption[], query: string): CommandOption[] {
  const q = query.trim().toLowerCase();
  const starts = options.filter((o) => o.label.toLowerCase().startsWith(q) || o.value.toLowerCase().startsWith(q));
  return [
    ...starts,
    ...options.filter((o) => !starts.includes(o) && (o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))),
  ];
}

function SelectConfigChip({
  sessionKey,
  option,
  icon,
  className,
  title,
  footer,
}: {
  sessionKey: string;
  option: Extract<SessionConfigOption, { type: "select" }>;
  icon?: React.ReactNode;
  className?: string;
  title?: string;
  footer?: string;
}) {
  const label = selectCurrentLabel(option);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={`ag-chip${className ? ` ${className}` : ""}`} title={title ?? option.description ?? option.name}>
          {icon}
          <span>{label}</span>
          <ChevronDown size={10} className="text-fg-faint" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" side="top" className="ag-menu">
        <div className="ag-menu-label">{option.name}</div>
        {isGroupedOptions(option.options) ? (
          option.options.map((group, gi) => (
            <div key={group.group}>
              {gi > 0 && <MenuSeparator />}
              <div className="ag-menu-group">{group.name}</div>
              {group.options.map((choice) => (
                <MenuItem
                  key={choice.value}
                  checked={choice.value === option.currentValue}
                  onSelect={() => void setConfigValue(sessionKey, option.id, choice.value)}
                >
                  <span>{choice.name}</span>
                </MenuItem>
              ))}
            </div>
          ))
        ) : (
          option.options.map((choice) => (
            <MenuItem
              key={choice.value}
              checked={choice.value === option.currentValue}
              onSelect={() => void setConfigValue(sessionKey, option.id, choice.value)}
            >
              <span>{choice.name}</span>
            </MenuItem>
          ))
        )}
        {footer && <div className="ag-menu-foot">{footer}</div>}
      </MenuContent>
    </Menu>
  );
}

function ModeIconFor({ tone }: { tone: ReturnType<typeof modeTone> }) {
  if (tone === "plan") return <ListChecks size={11} />;
  if (tone === "accept") return <FilePen size={11} />;
  if (tone === "bypass") return <ShieldOff size={11} />;
  return <Shield size={11} />;
}

function ExtraOptionsMenu({ sessionKey, options }: { sessionKey: string; options: SessionConfigOption[] }) {
  if (options.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="ag-chip" title="More session options" aria-label="More session options">
          <MoreHorizontal size={12} />
        </button>
      </MenuTrigger>
      <MenuContent align="start" side="top" className="ag-menu">
        <div className="ag-menu-label">Session options</div>
        {options.map((opt) => {
          if (opt.type === "boolean") {
            return (
              <MenuItem
                key={opt.id}
                checked={opt.currentValue}
                onSelect={() => void setConfigValue(sessionKey, opt.id, !opt.currentValue)}
              >
                {opt.name}
              </MenuItem>
            );
          }
          const flat = flattenSelectOptions(opt);
          const idx = flat.findIndex((o) => o.value === opt.currentValue);
          const next = flat.length > 0 ? flat[(idx + 1) % flat.length] : undefined;
          return (
            <MenuItem
              key={opt.id}
              onSelect={() => next && void setConfigValue(sessionKey, opt.id, next.value)}
            >
              <span>
                {opt.name}: <span className="text-fg-dim">{selectCurrentLabel(opt)}</span>
              </span>
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

export function Composer({ sessionKey, inputRef }: { sessionKey: string; inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const status = useSession(sessionKey, (s) => s?.status);
  const cwd = useSession(sessionKey, (s) => s?.cwd ?? "");
  const configOptions = useSession(sessionKey, (s) => s?.configOptions ?? []);
  const modes = useSession(sessionKey, (s) => s?.modes);
  const availableCommands = useSession(sessionKey, (s) => s?.availableCommands ?? []);
  // ACP image capability is opt-in: omitted after initialize means unsupported.
  const supportsImages = useSession(sessionKey, (s) => (s?.capabilities ? s.capabilities.promptCapabilities?.image === true : true));
  const usage = useSession(sessionKey, (s) => s?.usage);
  const loading = useSession(sessionKey, (s) => s?.loadingTranscript === true);

  const [text, setText] = useState(() => getDraft(sessionKey)?.text ?? "");
  const [images, setImages] = useState<ImageAttachment[]>(() => getDraft(sessionKey)?.images ?? []);
  const [mentions, setMentions] = useState<FileMention[]>(() => getDraft(sessionKey)?.mentions ?? []);
  useEffect(() => setDraft(sessionKey, { text, images, mentions }), [sessionKey, text, images, mentions]);

  const [selected, setSelected] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const history = useRef<{ index: number; draft: string } | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const running = status === "running";
  const percent = contextPercent(usage?.used, usage?.size);

  useEffect(() => {
    inserters.set(sessionKey, (value) => {
      setText(value);
      setMenuClosed(false);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        el?.focus();
        el?.setSelectionRange(value.length, value.length);
      });
    });
    restorers.set(sessionKey, (incoming) => {
      setText((cur) => (cur.trim() && incoming.text.trim() ? `${cur}\n${incoming.text}` : cur || incoming.text));
      if (incoming.images.length) setImages((cur) => [...cur, ...incoming.images]);
      if (incoming.mentions.length) {
        setMentions((cur) => [...cur, ...incoming.mentions.filter((m) => !cur.some((e) => e.path === m.path))]);
      }
      setMenuClosed(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    return () => {
      inserters.delete(sessionKey);
      restorers.delete(sessionKey);
    };
  }, [sessionKey, inputRef]);

  // Trigger detection: `/cmd`, `/cmd arg`, or `@file` at end of input.
  const slash = /^\/(\S*)$/.exec(text);
  const slashArg = /^\/(\S+) ([^\n]*)$/.exec(text);
  const atMatch = !slash && !slashArg ? /(?:^|\s)@([^\s@]*)$/.exec(text) : null;
  const optionsFor = slashArg ? findPaneCommand(`/${slashArg[1]}`)?.command : undefined;

  const commands = useMemo(() => commandList({ availableCommands, cwd }), [availableCommands, cwd]);
  const slashMatches = useMemo(() => (slash ? rankCommands(commands, slash[1]).slice(0, 200) : []), [slash?.[1], commands]);
  const optionMatches = useMemo(() => {
    const s = getSession(sessionKey);
    return optionsFor?.options && s && slashArg ? rankOptions(optionsFor.options(s), slashArg[2]) : [];
  }, [optionsFor, slashArg?.[2], sessionKey, configOptions, modes]);

  useEffect(() => {
    if (!atMatch || !cwd) return;
    let active = true;
    void workspaceFiles(cwd).then((paths) => {
      if (active) setFilePaths(paths);
    });
    return () => {
      active = false;
    };
  }, [Boolean(atMatch), cwd]);

  const fileMatches = useMemo(() => {
    if (!atMatch) return [];
    const q = atMatch[1];
    if (!q) return filePaths.slice(0, 30);
    return fuzzysort.go(q, filePaths, { limit: 30 }).map((r) => r.target);
  }, [atMatch?.[1], filePaths]);

  const modeKind: "slash" | "option" | "mention" | null = slash
    ? slashMatches.length > 0
      ? "slash"
      : null
    : optionMatches.length > 0
      ? "option"
      : atMatch && fileMatches.length > 0
        ? "mention"
        : null;
  const count = modeKind === "slash" ? slashMatches.length : modeKind === "option" ? optionMatches.length : modeKind === "mention" ? fileMatches.length : 0;
  const menuOpen = !menuClosed && count > 0;
  const activeIdx = Math.min(selected, Math.max(0, count - 1));

  useEffect(() => setSelected(0), [slash?.[1], slashArg?.[2], atMatch?.[1]]);
  useEffect(() => {
    if (slash) warmUp(sessionKey);
  }, [Boolean(slash), sessionKey]);
  useEffect(() => {
    if (availableCommands.length) rememberCommands(cwd, availableCommands);
  }, [availableCommands, cwd]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const runPaneCommand = (command: PaneCommand, args: string, typed: string) => {
    setText("");
    setDraft(sessionKey, { text: "", images, mentions });
    history.current = undefined;
    void Promise.resolve(
      command.run(sessionKey, args, {
        send: (msg) => send(msg),
        restore: () => setText((cur) => (cur === "" ? typed : cur)),
      }),
    );
  };

  const send = (value = text) => {
    const found = findPaneCommand(value);
    if (found) {
      if (loading) return;
      if (found.command.options && !found.args.trim()) {
        setText(`/${found.command.name} `);
        setMenuClosed(false);
        return;
      }
      runPaneCommand(found.command, found.args, value);
      return;
    }
    if ((!value.trim() && images.length === 0 && mentions.length === 0) || loading) return;
    const sentImages = images;
    const sentMentions = mentions;
    setText("");
    setImages([]);
    setMentions([]);
    history.current = undefined;
    void sendMessage(sessionKey, value, sentImages, sentMentions).then((ok) => {
      if (ok) return;
      // Not sent (refused permission mode or unsupported image): restore the draft without clobbering new typing.
      setText((cur) => (cur === "" ? value : cur));
      setImages((cur) => (cur.length === 0 ? sentImages : cur));
      setMentions((cur) => (cur.length === 0 ? sentMentions : cur));
    });
  };

  const pickCommand = (cmd: ListedCommand, execute: boolean) => {
    const paneCmd = cmd.source === "pane" ? findPaneCommand(`/${cmd.name}`)?.command : undefined;
    if (paneCmd?.options) {
      setText(`/${cmd.name} `);
      setMenuClosed(false);
    } else if (execute && !cmd.argumentHint) {
      send(`/${cmd.name}`);
    } else {
      setText(`/${cmd.name} `);
      setMenuClosed(true);
    }
  };

  const pickOption = (opt: CommandOption) => {
    if (!optionsFor || loading) return;
    runPaneCommand(optionsFor, opt.value, `/${optionsFor.name} ${opt.value}`);
  };

  const pickFile = (relPath: string) => {
    if (!atMatch) return;
    const abs = `${cwd.replace(/\/+$/, "")}/${relPath}`;
    setMentions((cur) => (cur.some((m) => m.path === abs) ? cur : [...cur, { path: abs, label: relPath }]));
    // Strip the `@query` token from the textarea cleanly.
    const idx = text.lastIndexOf(`@${atMatch[1]}`);
    const next = idx >= 0 ? `${text.slice(0, idx)}${text.slice(idx + atMatch[1].length + 1)}`.replace(/\s+$/, " ") : text;
    setText(next.trim() === "" ? "" : next);
    setMenuClosed(true);
    inputRef.current?.focus();
  };

  const userTexts = () => (getSession(sessionKey)?.items ?? []).flatMap((it) => (it.kind === "user" && it.text ? [it.text] : []));
  const recall = (dir: -1 | 1): boolean => {
    const past = userTexts();
    if (!past.length) return false;
    const state = history.current ?? { index: past.length, draft: text };
    const idx = Math.min(past.length, Math.max(0, state.index + dir));
    if (idx === state.index) return false;
    history.current = { index: idx, draft: state.draft };
    setText(idx === past.length ? state.draft : past[idx]);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((activeIdx + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
        return;
      }
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        if (modeKind === "slash") pickCommand(slashMatches[activeIdx], false);
        else if (modeKind === "option") setText(`/${slashArg?.[1]} ${optionMatches[activeIdx].value}`);
        else if (modeKind === "mention") pickFile(fileMatches[activeIdx]);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (modeKind === "slash") pickCommand(slashMatches[activeIdx], true);
        else if (modeKind === "option") pickOption(optionMatches[activeIdx]);
        else if (modeKind === "mention") pickFile(fileMatches[activeIdx]);
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
      cycleMode(sessionKey);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!text.trim() && images.length === 0 && mentions.length === 0) {
        const perm = getSession(sessionKey)?.permissions[0];
        if (perm) allowPermissionByEnter(sessionKey, perm);
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
    if (!supportsImages) return;
    const read = (await Promise.all([...files].map(readImage))).filter((img): img is ImageAttachment => img !== undefined);
    if (read.length) setImages((cur) => [...cur, ...read]);
  };

  const onPaste = (event: ClipboardEvent) => {
    const files = [...event.clipboardData.files].filter((f) => IMAGE_TYPES.has(f.type));
    if (!files.length || !supportsImages) return;
    event.preventDefault();
    void addFiles(files);
  };

  const onDrop = (event: DragEvent) => {
    setDragging(false);
    const files = [...event.dataTransfer.files].filter((f) => IMAGE_TYPES.has(f.type));
    if (!files.length || !supportsImages) return;
    event.preventDefault();
    void addFiles(files);
  };

  // Partition dynamic ACP configOptions into primary chips vs overflow menu.
  const modeOpt = findConfigOption(configOptions, "mode");
  const modelOpt = findConfigOption(configOptions, "model");
  const thoughtOpt = findConfigOption(configOptions, "thought_level");
  const primaryIds = new Set([modeOpt?.id, modelOpt?.id, thoughtOpt?.id].filter(Boolean));
  const extraOpts = configOptions.filter((o) => !primaryIds.has(o.id));

  const currentModeId = modeOpt?.type === "select" ? modeOpt.currentValue : modes?.currentModeId;
  const tone = modeTone(currentModeId);
  const canSend = (text.trim() !== "" || images.length > 0 || mentions.length > 0) && !loading;

  return (
    <div className="ag-composer-wrap">
      {menuOpen && (
        <div ref={listRef} className="ag-popup" role="listbox" aria-label={modeKind === "mention" ? "Files" : "Commands"}>
          {modeKind === "slash" &&
            slashMatches.map((cmd, idx) => (
              <div
                key={`${cmd.name}:${idx}`}
                data-index={idx}
                role="option"
                aria-selected={idx === activeIdx}
                className={`ag-popup-item${idx === activeIdx ? " is-active" : ""}`}
                onMouseEnter={() => setSelected(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickCommand(cmd, true);
                }}
              >
                <span className="ag-popup-name">/{cmd.name}</span>
                {cmd.argumentHint && <span className="ag-popup-hint">{cmd.argumentHint}</span>}
                <span className="ag-popup-desc">{cmd.description}</span>
              </div>
            ))}
          {modeKind === "option" &&
            optionMatches.map((opt, idx) => (
              <div
                key={opt.value}
                data-index={idx}
                role="option"
                aria-selected={idx === activeIdx}
                className={`ag-popup-item${idx === activeIdx ? " is-active" : ""}`}
                onMouseEnter={() => setSelected(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickOption(opt);
                }}
              >
                <span className="ag-popup-name is-option">{opt.label}</span>
                {opt.label.toLowerCase() !== opt.value.toLowerCase() && <span className="ag-popup-hint">{opt.value}</span>}
                {opt.current && <span className="ag-popup-desc ag-popup-current">current</span>}
              </div>
            ))}
          {modeKind === "mention" &&
            fileMatches.map((path, idx) => (
              <div
                key={path}
                data-index={idx}
                role="option"
                aria-selected={idx === activeIdx}
                className={`ag-popup-item${idx === activeIdx ? " is-active" : ""}`}
                onMouseEnter={() => setSelected(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickFile(path);
                }}
              >
                <FileText size={11} className="text-fg-dim flex-none" />
                <span className="ag-popup-name">{path}</span>
              </div>
            ))}
          {modeKind === "slash" && status === "starting" && (
            <div className="ag-popup-loading">Loading Antigravity commands…</div>
          )}
        </div>
      )}

      <div
        className={`ag-composer${dragging ? " is-dragging" : ""}`}
        onDragOver={(e) => {
          if (supportsImages && [...e.dataTransfer.items].some((i) => i.kind === "file")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {(mentions.length > 0 || images.length > 0) && (
          <div className="ag-attachments">
            {mentions.map((m) => (
              <span key={m.path} className="ag-mention-chip ag-mono">
                <FileText size={10} className="text-fg-dim" />
                <span>@{m.label}</span>
                <button
                  type="button"
                  className="ag-chip-remove"
                  aria-label={`Remove ${m.label}`}
                  onClick={() => setMentions((cur) => cur.filter((x) => x.path !== m.path))}
                >
                  <X size={9} />
                </button>
              </span>
            ))}
            {images.map((image, idx) => (
              <span key={idx} className="ag-attachment">
                <img src={`data:${image.mediaType};base64,${image.data}`} alt="" className="ag-thumb" />
                <button
                  type="button"
                  className="ag-attachment-remove"
                  aria-label="Remove image"
                  onClick={() => setImages(images.filter((_, other) => other !== idx))}
                >
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
          className="ag-input"
          placeholder={loading ? "Loading session transcript…" : running ? "Queue another message…" : "Message Antigravity… (@ files, / commands)"}
          aria-label="Message Antigravity"
          spellCheck
          onChange={(e) => {
            setText(e.target.value);
            setMenuClosed(false);
            history.current = undefined;
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        <div className="ag-bar">
          <button
            type="button"
            className="ag-icon-button"
            title={supportsImages ? "Attach images" : "This agent does not advertise image support"}
            aria-label="Attach images"
            disabled={!supportsImages}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip size={12} />
          </button>
          <button
            type="button"
            className="ag-icon-button"
            title="Mention a file (@)"
            aria-label="Mention a file"
            onClick={() => {
              const sep = text && !text.endsWith(" ") ? " " : "";
              setText(`${text}${sep}@`);
              setMenuClosed(false);
              inputRef.current?.focus();
            }}
          >
            <AtSign size={12} />
          </button>
          <button
            type="button"
            className="ag-icon-button"
            title="Commands (/)"
            aria-label="Commands"
            onClick={() => {
              setText("/");
              setMenuClosed(false);
              inputRef.current?.focus();
            }}
          >
            <Slash size={12} />
          </button>

          {modeOpt?.type === "select" ? (
            <SelectConfigChip
              sessionKey={sessionKey}
              option={modeOpt}
              icon={<ModeIconFor tone={tone} />}
              className={`ag-mode is-${tone}`}
              title="Session mode (⇧⇥ cycles)"
              footer="⇧⇥ cycles modes"
            />
          ) : modes && modes.availableModes.length > 0 ? (
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className={`ag-chip ag-mode is-${tone}`} title="Session mode (⇧⇥ cycles)">
                  <ModeIconFor tone={tone} />
                  <span>{modes.availableModes.find((m) => m.id === modes.currentModeId)?.name ?? modes.currentModeId}</span>
                </button>
              </MenuTrigger>
              <MenuContent align="start" side="top" className="ag-menu">
                {modes.availableModes.map((m) => (
                  <MenuItem key={m.id} checked={m.id === modes.currentModeId} onSelect={() => void setModeValue(sessionKey, m.id)}>
                    {m.name}
                  </MenuItem>
                ))}
                <div className="ag-menu-foot">⇧⇥ cycles modes</div>
              </MenuContent>
            </Menu>
          ) : null}

          {modelOpt?.type === "select" && <SelectConfigChip sessionKey={sessionKey} option={modelOpt} />}
          {thoughtOpt?.type === "select" && (
            <SelectConfigChip
              sessionKey={sessionKey}
              option={thoughtOpt}
              icon={<Gauge size={11} className="text-fg-dim" />}
            />
          )}
          <ExtraOptionsMenu sessionKey={sessionKey} options={extraOpts} />

          <span className="ag-bar-spacer" />

          {percent !== undefined && (
            <button
              type="button"
              className={`ag-bar-context ag-num${percent > 70 ? ` text-${levelOf(percent)}` : ""}`}
              title="Context used: open session details"
              onClick={() => setPanel(sessionKey, "session")}
            >
              {percent}%
            </button>
          )}
          {running && !canSend ? (
            <button type="button" className="ag-send is-stop" title="Stop (Esc)" aria-label="Stop" onClick={() => void interrupt(sessionKey)}>
              <Square size={9} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="ag-send" title={running ? "Queue (⏎)" : "Send (⏎)"} aria-label="Send" disabled={!canSend} onClick={() => send()}>
              <ArrowUp size={13} />
            </button>
          )}
        </div>

        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
