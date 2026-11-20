import { File, FileCode, FileImage, FileText, Folder, FolderOpen, type LucideIcon } from "lucide-react";
import { extensionsOf } from "../resolve";
import type { LoadedIconSet } from "../types";

/* A monochrome set from lucide, drawn in the row's text color: folders, code, text, images, other files. */

const CODE =
  "c cc cpp cs css go h hpp html java js jsx json jsonc kt lua mjs php py rb rs scss sh sql swift toml ts tsx vue xml yaml yml zsh".split(
    " ",
  );
const TEXT = "log md markdown rst txt".split(" ");
const IMAGE = "avif bmp gif heic ico jpeg jpg png svg tiff webp".split(" ");

const BY_EXTENSION = new Map<string, LucideIcon>([
  ...CODE.map((ext) => [ext, FileCode] as const),
  ...TEXT.map((ext) => [ext, FileText] as const),
  ...IMAGE.map((ext) => [ext, FileImage] as const),
]);

export const minimalSet: LoadedIconSet = {
  id: "minimal",
  icon(query, specificOnly) {
    if (query.kind === "dir") return specificOnly ? null : { lucide: query.expanded ? FolderOpen : Folder };
    for (const ext of extensionsOf(query.name)) {
      const icon = BY_EXTENSION.get(ext);
      if (icon) return { lucide: icon };
    }
    return specificOnly ? null : { lucide: File };
  },
};
