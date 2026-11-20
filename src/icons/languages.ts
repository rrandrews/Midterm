/*
 * VS Code language ids by extension and file name, for icon sets whose
 * `languageIds` mapping covers files their `fileExtensions` do not. Only
 * common languages; a set's own extension and file name mappings come
 * first anyway.
 */

const BY_EXTENSION = new Map<string, string>(
  Object.entries({
    bat: "bat",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    cs: "csharp",
    css: "css",
    csv: "csv",
    dart: "dart",
    diff: "diff",
    patch: "diff",
    ex: "elixir",
    exs: "elixir",
    erl: "erlang",
    fs: "fsharp",
    go: "go",
    graphql: "graphql",
    gql: "graphql",
    groovy: "groovy",
    hs: "haskell",
    html: "html",
    htm: "html",
    ini: "ini",
    java: "java",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascriptreact",
    json: "json",
    jsonc: "jsonc",
    jsonl: "jsonl",
    jl: "julia",
    kt: "kotlin",
    kts: "kotlin",
    tex: "latex",
    less: "less",
    log: "log",
    lua: "lua",
    md: "markdown",
    markdown: "markdown",
    m: "objective-c",
    mm: "objective-cpp",
    pl: "perl",
    php: "php",
    ps1: "powershell",
    properties: "properties",
    proto: "proto",
    py: "python",
    r: "r",
    rb: "ruby",
    rs: "rust",
    scala: "scala",
    scss: "scss",
    sass: "sass",
    sh: "shellscript",
    bash: "shellscript",
    zsh: "shellscript",
    fish: "shellscript",
    sql: "sql",
    svelte: "svelte",
    svg: "svg",
    swift: "swift",
    tf: "terraform",
    toml: "toml",
    ts: "typescript",
    mts: "typescript",
    cts: "typescript",
    tsx: "typescriptreact",
    txt: "plaintext",
    vue: "vue",
    xml: "xml",
    yml: "yaml",
    yaml: "yaml",
  }),
);

const BY_NAME = new Map<string, string>(
  Object.entries({
    makefile: "makefile",
    gnumakefile: "makefile",
    dockerfile: "dockerfile",
    ".gitignore": "ignore",
    ".dockerignore": "ignore",
    ".editorconfig": "editorconfig",
    "requirements.txt": "pip-requirements",
  }),
);

/** The VS Code language id of a file, from its name, then its last extension. */
export function languageIdOf(name: string): string | undefined {
  const lower = name.toLowerCase();
  const byName = BY_NAME.get(lower);
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? BY_EXTENSION.get(lower.slice(dot + 1)) : undefined;
}
