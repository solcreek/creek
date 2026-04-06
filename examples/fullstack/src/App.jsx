import { useState } from "react";
import { useLiveQuery } from "loopix/react";

export default function App() {
  const [title, setTitle] = useState("");

  const { data, loading, mutate, connected } = useLiveQuery(
    "/api/todos",
    `wss://loopix-realtime.kaik.workers.dev/fullstack-demo/ws`,
  );
  const todos = data?.todos ?? [];
  const visits = data?.visits ?? 0;

  async function addTodo(e) {
    e.preventDefault();
    if (!title.trim()) return;
    const newTitle = title;
    setTitle("");

    await mutate(
      () => fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      }),
      // Optimistic: show the todo immediately
      (prev) => ({
        ...prev,
        todos: [{ id: "optimistic", title: newTitle, completed: 0 }, ...(prev?.todos ?? [])],
      }),
    );
  }

  async function deleteTodo(id) {
    await mutate(
      () => fetch(`/api/todos/${id}`, { method: "DELETE" }),
      // Optimistic: remove from list immediately
      (prev) => ({
        ...prev,
        todos: (prev?.todos ?? []).filter(t => t.id !== id),
      }),
    );
  }

  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 480, margin: "2rem auto", padding: "0 1rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: 4 }}>Loopix Todo App</h1>
      <p style={{ color: "#666", fontSize: "0.8rem", margin: "0 0 0.5rem" }}>
        Full-stack on Cloudflare — D1 + KV + Durable Objects realtime
      </p>

      <div style={{ display: "flex", gap: 12, fontSize: "0.75rem", margin: "0 0 1rem", color: "#999" }}>
        <span>
          <span style={{
            display: "inline-block", width: 7, height: 7, borderRadius: "50%",
            background: connected ? "#22c55e" : "#f59e0b", marginRight: 4, verticalAlign: "middle",
          }} />
          {connected ? "Live" : "Connecting..."}
        </span>
        <span>Views: {visits}</span>
      </div>

      <form onSubmit={addTodo} style={{ display: "flex", gap: 8, margin: "0 0 1rem" }}>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="What needs to be done?"
          style={{ flex: 1, padding: "0.5rem", border: "1px solid #ddd", borderRadius: 4, fontSize: "0.9rem" }}
        />
        <button type="submit" style={{ padding: "0.5rem 1rem", background: "#2563eb", color: "white", border: "none", borderRadius: 4, cursor: "pointer", fontSize: "0.9rem" }}>
          Add
        </button>
      </form>

      {loading ? <p>Loading...</p> : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {todos.map(todo => (
            <li key={todo.id} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "0.5rem 0", borderBottom: "1px solid #eee",
              opacity: todo.id === "optimistic" ? 0.5 : 1,
            }}>
              <span>{todo.title}</span>
              <button onClick={() => deleteTodo(todo.id)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer" }}>
                delete
              </button>
            </li>
          ))}
          {todos.length === 0 && <li style={{ color: "#aaa", padding: "0.5rem 0" }}>No todos yet</li>}
        </ul>
      )}

      <p style={{ marginTop: "2rem", fontSize: "0.7rem", color: "#ccc", textAlign: "center" }}>
        Open in two tabs to see realtime sync
      </p>
    </div>
  );
}
