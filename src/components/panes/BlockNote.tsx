import { ChevronDown, ChevronRight, ClipboardCopy, RotateCw, Square, X } from "lucide-react";
import { dismissNote, explainBlock, stopNote, toggleNote, useBlockNotes } from "../../ai/blockNotes";
import { copyText } from "../../ipc/clipboard";
import type { Block } from "../../terminal/blocks";
import { Markdown } from "../ui/Markdown";

/**
 * The AI note under a finished block (Explain, src/ai/blockNotes.ts). It
 * subscribes to its own note, so the memoized block does not re-render
 * while text streams.
 */
export function BlockNote({ paneId, block }: { paneId: string; block: Block }) {
  const note = useBlockNotes((state) => state[paneId]?.[block.id]);
  if (!note) return null;
  const running = note.status === "loading" || note.status === "streaming";
  const state = note.status === "loading"
    ? "thinking…"
    : note.cut
      ? "cut off at the token limit"
      : note.stopped
        ? "stopped"
        : "";
  return (
    <div className="block-ai">
      <div className="blocks-meta block-ai-header">
        <button
          type="button"
          className="block-ai-title"
          aria-expanded={!note.collapsed}
          onClick={() => toggleNote(paneId, block.id)}
        >
          {note.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span>AI · explanation</span>
        </button>
        {state && <span className={`truncate${note.status === "loading" ? " animate-pulse" : ""}`}>{state}</span>}
        <span className="ml-auto" />
        <span className="block-ai-actions">
          {running && (
            <NoteButton label="Stop" onClick={() => stopNote(paneId, block.id)}>
              <Square size={10} />
            </NoteButton>
          )}
          <NoteButton label="Copy" disabled={!note.text} onClick={() => void copyText(note.text)}>
            <ClipboardCopy size={12} />
          </NoteButton>
          <NoteButton label="Retry" onClick={() => explainBlock(paneId, block)}>
            <RotateCw size={12} />
          </NoteButton>
          <NoteButton label="Dismiss" onClick={() => dismissNote(paneId, block.id)}>
            <X size={12} />
          </NoteButton>
        </span>
      </div>
      {!note.collapsed && (note.text || note.error) && (
        <div className="block-ai-body">
          {note.text && <Markdown text={note.text} compact />}
          {note.error && <div className="block-ai-error text-err">{note.error}</div>}
        </div>
      )}
    </div>
  );
}

function NoteButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className="block-action" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
