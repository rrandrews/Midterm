import { Check, ChevronRight, Circle, CircleDot, ListTodo } from "lucide-react";
import { useState } from "react";
import { useSession } from "../store";
import type { Todo } from "../types";

/*
 * The latest TodoWrite list, pinned above the composer as one line
 * ("3/7 · Running the test suite") that expands to the checklist. Hidden
 * once everything is done.
 */

const NONE: Todo[] = [];

export function Todos({ sessionKey }: { sessionKey: string }) {
  const todos = useSession(sessionKey, (session) => session?.todos ?? NONE);
  const [open, setOpen] = useState(false);
  if (todos.length === 0) return null;
  const done = todos.filter((todo) => todo.status === "completed").length;
  if (done === todos.length) return null;
  const current = todos.find((todo) => todo.status === "in_progress");
  return (
    <div className={`cc-todos${open ? " is-open" : ""}`}>
      <button type="button" className="cc-todos-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ListTodo size={12} className="text-fg-dim" />
        <span className="cc-num text-fg-mid">
          {done}/{todos.length}
        </span>
        <span className="cc-todos-current">{current ? (current.activeForm ?? current.content) : "To-dos"}</span>
        <ChevronRight size={11} className="cc-chevron" aria-hidden="true" />
      </button>
      {open && (
        <ul className="cc-checklist">
          {todos.map((todo, index) => (
            <li key={index} className={`is-${todo.status}`}>
              {todo.status === "completed" ? <Check size={11} /> : todo.status === "in_progress" ? <CircleDot size={11} /> : <Circle size={11} />}
              <span>{todo.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
