/*
 * What kind of file a path names, by extension: images and Markdown get
 * their own rendering in viewers; everything else is text. Pure.
 */

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The image MIME type for a path, or `undefined` if it is not an image the viewer shows. */
export function imageType(path: string): string | undefined {
  return IMAGE_TYPES[extension(path)];
}

export function isImagePath(path: string): boolean {
  return imageType(path) !== undefined;
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN.has(extension(path));
}

/** How a viewer pane shows a file. */
export type ViewerMode = "markdown" | "image" | "text";

export function viewerModeFor(path: string): ViewerMode {
  if (isImagePath(path)) return "image";
  if (isMarkdownPath(path)) return "markdown";
  return "text";
}
