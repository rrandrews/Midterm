import { remoteIdOf } from "../files/location";
import { watchFile } from "../files/watch";
import { imageType } from "../files/kinds";
import * as fs from "../ipc/fs";
import type { FileVersion } from "../ipc/fs";
import type { SshStatus } from "../ipc/ssh";
import { getConnection, subscribeConnections } from "../ssh/connections";
import { renderMarkdown } from "./markdown";

/*
 * A viewer pane showing rendered Markdown or an image. (Viewers of other
 * text use a read-only EditorModel.) Lives outside React, keyed by pane id
 * (src/editor/registry.ts): the rendered document, image data and scroll
 * position survive remounts. Reloads when the file changes on disk.
 */

export type ViewerStatus = "loading" | "ready" | "missing" | "binary" | "tooLarge" | "error";

export type ViewerSnapshot = {
  path: string;
  mode: "markdown" | "image";
  status: ViewerStatus;
  /** Sanitized HTML (Markdown). Image sources are in `data-src`, see `imageUrl`. */
  html: string | null;
  /** A blob URL (image). */
  imageUrl: string | null;
  size: number | null;
  error: string | null;
  /** Bumped on each (re)load: embedded images are resolved again. */
  revision: number;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class ViewerModel {
  readonly kind = "viewer";
  /** Scroll position, remembered across remounts by the component. */
  scrollTop = 0;

  private status: ViewerStatus = "loading";
  private html: string | null = null;
  private imageBlobUrl: string | null = null;
  private version: FileVersion | null = null;
  private error: string | null = null;
  /** Blob URLs of images a Markdown document shows, by path. */
  private readonly embedded = new Map<string, Promise<string | null>>();
  /** Embedded image paths that failed to load (e.g. while SSH was disconnected) and should retry on reconnect. */
  private readonly failedEmbedded = new Set<string>();

  private loadToken = 0;
  private checkToken = 0;
  private revision = 0;
  private unwatch: () => void;
  private readonly unsubSsh: () => void;
  private lastRemoteStatus: SshStatus | null = null;
  private attachCount = 0;
  private disposed = false;

  private readonly listeners = new Set<() => void>();
  private current: ViewerSnapshot;

  constructor(
    readonly paneId: string,
    private filePath: string,
    readonly mode: "markdown" | "image",
  ) {
    this.lastRemoteStatus = this.currentRemoteStatus();
    this.current = this.buildSnapshot();
    this.unwatch = watchFile(filePath, () => void this.checkDisk());
    this.unsubSsh = subscribeConnections(() => this.handleSshChange());
    void this.load();
  }

  get path(): string {
    return this.filePath;
  }

  readonly isDirty = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): ViewerSnapshot => this.current;

  private emit(): void {
    this.current = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): ViewerSnapshot {
    return {
      path: this.filePath,
      mode: this.mode,
      status: this.status,
      html: this.html,
      imageUrl: this.imageBlobUrl,
      size: this.version?.size ?? null,
      error: this.error,
      revision: this.revision,
    };
  }

  attach(): void {
    if (this.disposed) return;
    this.attachCount++;
    if (this.attachCount === 1) void this.checkDisk();
  }

  detach(): void {
    this.attachCount = Math.max(0, this.attachCount - 1);
  }

  get isAttached(): boolean {
    return this.attachCount > 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubSsh();
    this.unwatch();
    this.loadToken++;
    if (this.imageBlobUrl) URL.revokeObjectURL(this.imageBlobUrl);
    this.forgetEmbedded();
    this.listeners.clear();
  }

  private currentRemoteStatus(): SshStatus | null {
    const rid = remoteIdOf(this.filePath);
    return rid ? (getConnection(rid)?.status ?? "disconnected") : null;
  }

  private handleSshChange(): void {
    if (this.disposed) return;
    const status = this.currentRemoteStatus();
    const prev = this.lastRemoteStatus;
    this.lastRemoteStatus = status;
    if (status === "connected" && prev !== "connected") {
      if (this.status !== "ready") {
        void this.load();
      } else {
        if (this.failedEmbedded.size > 0) {
          for (const path of this.failedEmbedded) this.embedded.delete(path);
          this.failedEmbedded.clear();
          this.revision++;
          this.emit();
        }
        void this.checkDisk();
      }
    }
  }

  /** The file was renamed or moved. */
  setPath(path: string): void {
    if (path === this.filePath) return;
    this.filePath = path;
    this.lastRemoteStatus = this.currentRemoteStatus();
    this.unwatch();
    this.unwatch = watchFile(path, () => void this.checkDisk());
    this.emit();
  }

  /** A blob URL for an image file a Markdown document shows, or `null` if it cannot be read. */
  imageUrl(path: string): Promise<string | null> {
    let url = this.embedded.get(path);
    if (!url) {
      const type = imageType(path);
      url = type
        ? fs.readFileBytes(path).then(
            (bytes) => {
              this.failedEmbedded.delete(path);
              return this.disposed ? null : URL.createObjectURL(new Blob([bytes], { type }));
            },
            () => {
              this.failedEmbedded.add(path);
              return null;
            },
          )
        : Promise.resolve(null);
      this.embedded.set(path, url);
    }
    return url;
  }

  private forgetEmbedded(): void {
    for (const url of this.embedded.values()) {
      void url.then((href) => href && URL.revokeObjectURL(href));
    }
    this.embedded.clear();
    this.failedEmbedded.clear();
  }

  private async load(): Promise<void> {
    const token = ++this.loadToken;
    const path = this.filePath;
    try {
      if (this.mode === "markdown") await this.loadMarkdown(path, token);
      else await this.loadImage(path, token);
    } catch (error) {
      let version: FileVersion | null | undefined;
      try {
        version = await fs.fileVersion(path);
      } catch {
        version = undefined;
      }
      if (token !== this.loadToken) return;
      this.status = version === null ? "missing" : "error";
      this.error = version === null ? null : message(error);
      this.version = version ?? null;
    }
    if (token === this.loadToken) this.emit();
  }

  private async loadMarkdown(path: string, token: number): Promise<void> {
    const file = await fs.readTextFile(path);
    if (token !== this.loadToken) return;
    this.version = file.version;
    this.error = null;
    if (file.kind !== "text") {
      this.status = file.kind;
      this.html = null;
      return;
    }
    // Embedded images may have changed too.
    this.forgetEmbedded();
    this.revision++;
    this.html = renderMarkdown(file.text);
    this.status = "ready";
  }

  private async loadImage(path: string, token: number): Promise<void> {
    const version = await fs.fileVersion(path);
    if (!version) throw new Error("missing");
    const bytes = await fs.readFileBytes(path);
    if (token !== this.loadToken) return;
    if (this.imageBlobUrl) URL.revokeObjectURL(this.imageBlobUrl);
    this.imageBlobUrl = URL.createObjectURL(new Blob([bytes], { type: imageType(path) }));
    this.version = version;
    this.error = null;
    this.status = "ready";
  }

  private async checkDisk(): Promise<void> {
    if (this.disposed || this.status === "loading") return;
    const token = ++this.checkToken;
    const path = this.filePath;
    const version = await fs.fileVersion(path).catch(() => undefined);
    if (version === undefined || token !== this.checkToken || this.disposed || path !== this.filePath) return;
    if (!fs.sameVersion(version, this.version)) void this.load();
  }
}
