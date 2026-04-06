import type { Todo } from "../types.js";

interface DatabaseViewProps {
  todos: Todo[];
  flashVersions: Map<string, number>;
  onFlashEnd: (id: string) => void;
}

export function DatabaseView({ todos, flashVersions, onFlashEnd }: DatabaseViewProps) {
  return (
    <div className="db-view">
      <div className="db-header">
        <span className="db-icon" />
        <span className="db-title">todos</span>
        <span className="db-meta">
          {todos.length} row{todos.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="db-table-wrap">
        <table className="db-table">
          <thead>
            <tr>
              <th>id</th>
              <th>text</th>
              <th>completed</th>
              <th>created_at</th>
            </tr>
          </thead>
          <tbody>
            {todos.map((todo) => {
              const version = flashVersions.get(todo.id);
              return (
                <tr
                  key={`${todo.id}-${version ?? 0}`}
                  className={version ? "row-flash" : ""}
                  onAnimationEnd={() => onFlashEnd(todo.id)}
                >
                  <td className="cell-id">{todo.id}</td>
                  <td className="cell-text">{todo.text}</td>
                  <td className="cell-bool">{todo.completed ? "true" : "false"}</td>
                  <td className="cell-date">{todo.created_at?.slice(0, 16) ?? ""}</td>
                </tr>
              );
            })}
            {todos.length === 0 && (
              <tr>
                <td colSpan={4} className="cell-empty">No rows</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
