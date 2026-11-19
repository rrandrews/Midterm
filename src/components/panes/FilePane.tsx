import { useEffect, useState } from "react";
import { EditorModel } from "../../editor/model";
import { type FileModel, acquireFileModel, releaseFileModel } from "../../editor/registry";
import { usePluginSettings } from "../../plugins/settings";
import { CodeView } from "./CodeView";
import { DocumentView } from "./DocumentView";
import { NoFile } from "./FileStatus";

type FileKind = "editor" | "viewer";

/** An editor pane: the file in CodeMirror. */
export function EditorPane({ paneId, path }: { paneId: string; path?: string }) {
  return <FilePane paneId={paneId} kind="editor" path={path} />;
}

/** A viewer pane: rendered Markdown, an image, or read-only text. */
export function ViewerPane({ paneId, path }: { paneId: string; path?: string }) {
  // Switching Markdown between rendered and source needs a new model.
  const markdown = usePluginSettings("viewer").markdown;
  return <FilePane key={String(markdown)} paneId={paneId} kind="viewer" path={path} />;
}

/**
 * An editor or viewer pane. The file's state lives in a model owned by the
 * registry (src/editor/registry.ts); this component only shows it.
 */
function FilePane({ paneId, kind, path }: { paneId: string; kind: FileKind; path?: string }) {
  if (!path) return <NoFile paneId={paneId} kind={kind} />;
  // A new kind or file means a new model, so start over.
  return <FileModelPane key={`${kind}:${path}`} paneId={paneId} kind={kind} path={path} />;
}

function FileModelPane({ paneId, kind, path }: { paneId: string; kind: FileKind; path: string }) {
  const [model, setModel] = useState<FileModel | null>(null);

  useEffect(() => {
    const acquired = acquireFileModel(paneId, kind, path);
    setModel(acquired);
    return () => releaseFileModel(acquired);
  }, [paneId, kind, path]);

  if (!model) return null;
  return model instanceof EditorModel ? (
    <CodeView paneId={paneId} model={model} />
  ) : (
    <DocumentView paneId={paneId} model={model} />
  );
}

