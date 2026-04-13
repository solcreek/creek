import { useEffect, useState } from "react";

interface Todo {
  id: number;
  title: string;
  done: boolean;
  createdAt: number;
}

export function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    try {
      const res = await fetch("/api/todos");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTodos((await res.json()) as Todo[]);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    await fetch("/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    refresh();
  }

  async function toggle(t: Todo) {
    await fetch(`/api/todos/${t.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: !t.done }),
    });
    refresh();
  }

  async function remove(t: Todo) {
    await fetch(`/api/todos/${t.id}`, { method: "DELETE" });
    refresh();
  }

  return (
    <main>
      <h1>Todos</h1>
      <p className="hint">
        Vite + React + Hono + Drizzle. Same code, two runtimes:
        better-sqlite3 locally, D1 on Creek.
      </p>

      <form onSubmit={add}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What needs doing?"
          autoFocus
        />
        <button type="submit">Add</button>
      </form>

      {err && <p className="err">api error: {err}</p>}

      <ul>
        {todos.map((t) => (
          <li key={t.id} className={t.done ? "done" : ""}>
            <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
            <span>{t.title}</span>
            <button onClick={() => remove(t)} aria-label="Delete">
              ×
            </button>
          </li>
        ))}
        {todos.length === 0 && <li className="empty">no todos yet</li>}
      </ul>
    </main>
  );
}
