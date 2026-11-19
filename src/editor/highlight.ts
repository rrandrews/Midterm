import { syntaxHighlighting } from "@codemirror/language";
import { tagHighlighter, tags as t } from "@lezer/highlight";

/*
 * Syntax highlighting as CSS classes, styled with the design tokens in
 * src/styles/editor.css. The classes follow the mockup's: keyword, string,
 * function, type, comment, punctuation.
 */

const highlighter = tagHighlighter([
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.definitionKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
      t.modifier,
      t.self,
      t.bool,
      t.null,
      t.atom,
    ],
    class: "tok-keyword",
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.escape], class: "tok-string" },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.function(t.definition(t.variableName)),
      t.macroName,
    ],
    class: "tok-function",
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.tagName, t.number, t.integer, t.float, t.unit],
    class: "tok-type",
  },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "tok-comment" },
  { tag: [t.angleBracket, t.meta, t.processingInstruction, t.documentMeta], class: "tok-punctuation" },
  { tag: [t.heading], class: "tok-heading" },
  { tag: [t.link, t.url], class: "tok-link" },
  { tag: [t.emphasis], class: "tok-emphasis" },
  { tag: [t.strong], class: "tok-strong" },
  { tag: [t.strikethrough], class: "tok-strike" },
  { tag: [t.invalid], class: "tok-invalid" },
  { tag: [t.deleted], class: "tok-deleted" },
  { tag: [t.inserted], class: "tok-inserted" },
]);

export const highlighting = syntaxHighlighting(highlighter);
