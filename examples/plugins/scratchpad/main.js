// @ts-check
/*
 * Scratchpad: an example Midterm pane plugin, written without a framework
 * (`pane.mount`). The text is kept in the pane's data, so it is saved with
 * the layout and survives restarts. See docs/plugins.md.
 */

/** @type {import("../../../src/plugins/types").PanePlugin} */
const plugin = {
  id: "scratchpad",
  name: "Scratchpad",
  pane: {
    validateData: (raw) => (typeof raw.text === "string" ? { text: raw.text } : {}),
    mount(el, ctx) {
      const area = document.createElement("textarea");
      area.className = "scratchpad";
      area.spellcheck = ctx.api.settings.get().spellcheck === true;
      area.placeholder = "Notes…";
      area.value = typeof ctx.data().text === "string" ? /** @type {string} */ (ctx.data().text) : "";
      area.dataset.scratchpad = ctx.paneId;
      let timer = 0;
      area.addEventListener("input", () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => ctx.updateData({ text: area.value }), 300);
      });
      el.append(area);
      const stopFocus = ctx.onFocusRequest(() => area.focus({ preventScroll: true }));
      const stopSettings = ctx.api.settings.subscribe((settings) => {
        area.spellcheck = settings.spellcheck === true;
      });
      return () => {
        clearTimeout(timer);
        ctx.updateData({ text: area.value });
        stopFocus();
        stopSettings();
      };
    },
    menu: (ctx) => notesMenu(ctx),
    // The … menu: the same items, and without the built-in "Agent" submenu.
    optionsMenu: (ctx) => notesMenu(ctx),
    hideMenuItems: ["agent"],
    tabTitle: () => "notes",
  },
  settings: {
    fields: [{ key: "spellcheck", type: "toggle", label: "Check spelling", default: false }],
  },
  commands: [
    {
      id: "scratchpad.copyAll",
      title: "Copy all scratchpad notes",
      category: "Scratchpad",
      run: () => {
        const text = allNotes().join("\n\n");
        void navigator.clipboard?.writeText(text);
      },
    },
  ],
  skills: [
    {
      id: "text",
      title: "Read scratchpad notes",
      description: "Read the text of every Scratchpad pane.",
      tools: [
        {
          name: "read_notes",
          description: "The notes in every Scratchpad pane, by pane id.",
          effect: "read",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          run: async (_input, ctx) =>
            ctx.api.panes
              .list()
              .filter((pane) => pane.data.kind === "scratchpad")
              .map((pane) => ({ paneId: pane.id, text: typeof pane.data.text === "string" ? pane.data.text : "" })),
        },
      ],
    },
  ],
  activate(api) {
    apiRef = api;
    return () => {
      apiRef = null;
    };
  },
};

/** @type {import("../../../src/plugins/api").MidtermApi | null} */
let apiRef = null;

function notesMenu(ctx) {
  return [
    {
      label: "Clear notes",
      disabled: !ctx.data().text,
      run: async () => {
        if (await ctx.api.ui.confirm({ title: "Clear the notes?", message: "This cannot be undone.", action: "Clear" })) {
          ctx.updateData({ text: "" });
          const area = document.querySelector(`[data-scratchpad="${ctx.paneId}"]`);
          if (area instanceof HTMLTextAreaElement) area.value = "";
        }
      },
    },
  ];
}

function allNotes() {
  if (!apiRef) return [];
  return apiRef.panes
    .list()
    .filter((pane) => pane.data.kind === "scratchpad" && typeof pane.data.text === "string")
    .map((pane) => /** @type {string} */ (pane.data.text));
}

export default plugin;
