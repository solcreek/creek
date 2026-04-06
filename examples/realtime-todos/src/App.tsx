import { useState, useCallback } from "react";
import { LiveRoom, useLiveQuery } from "creek/react";
import { useRoomId } from "./hooks/useRoomId.js";
import { StatusBar } from "./components/StatusBar.js";
import { TodoList } from "./components/TodoList.js";
import { TodoInput } from "./components/TodoInput.js";
import { ShareButton } from "./components/ShareButton.js";
import { DatabaseView } from "./components/DatabaseView.js";
import type { Todo } from "./types.js";

export function App() {
  const roomId = useRoomId();

  return (
    <LiveRoom id={roomId}>
      <SplitView roomId={roomId} />
    </LiveRoom>
  );
}

function SplitView({ roomId }: { roomId: string }) {
  // Version counter per row — increment on change, clear on animation end.
  // Used as key suffix to force CSS animation restart.
  const [flashVersions, setFlashVersions] = useState<Map<string, number>>(new Map());

  const handleChange = useCallback((next: Todo[], prev: Todo[] | null) => {
    if (!prev) return;

    const prevMap = new Map(prev.map((t) => [t.id, t]));
    const changed: string[] = [];

    for (const todo of next) {
      const old = prevMap.get(todo.id);
      if (!old || old.completed !== todo.completed || old.text !== todo.text) {
        changed.push(todo.id);
      }
    }

    if (changed.length > 0) {
      setFlashVersions((prev) => {
        const next = new Map(prev);
        for (const id of changed) next.set(id, (prev.get(id) ?? 0) + 1);
        return next;
      });
    }
  }, []);

  const clearFlash = useCallback((id: string) => {
    setFlashVersions((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const { data: todos, mutate } = useLiveQuery<Todo[]>("/api/todos", {
    initialData: [],
    onChange: handleChange,
  });

  const addTodo = (text: string) =>
    mutate(
      { method: "POST", path: "/api/todos", body: { text } },
      (prev) => [
        { id: crypto.randomUUID().slice(0, 8), text, completed: 0, created_at: new Date().toISOString() },
        ...prev,
      ],
    );

  const toggleTodo = (id: string) =>
    mutate(
      { method: "PATCH", path: `/api/todos/${id}` },
      (prev) => prev.map((t) => (t.id === id ? { ...t, completed: t.completed ? 0 : 1 } : t)),
    );

  const deleteTodo = (id: string) =>
    mutate(
      { method: "DELETE", path: `/api/todos/${id}` },
      (prev) => prev.filter((t) => t.id !== id),
    );

  return (
    <div className="split-layout">
      <div className="app-panel">
        <div className="app-chrome">
          <div className="chrome-dots">
            <span /><span /><span />
          </div>
          <span className="chrome-url">realtime-todos.creek.dev</span>
          <StatusBar />
        </div>
        <div className="app-content">
          <TodoInput onAdd={addTodo} />
          <TodoList todos={todos} onToggle={toggleTodo} onDelete={deleteTodo} />
          <div className="share-row">
            <ShareButton roomId={roomId} />
          </div>
        </div>
      </div>

      <div className="db-panel">
        <div className="app-chrome db-chrome">
          <div className="chrome-dots">
            <span /><span /><span />
          </div>
          <span className="chrome-url">dashboard.creek.dev</span>
        </div>
        <DatabaseView todos={todos} flashVersions={flashVersions} onFlashEnd={clearFlash} />
      </div>
    </div>
  );
}
