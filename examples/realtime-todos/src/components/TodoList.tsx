import type { Todo } from "../types.js";

interface TodoListProps {
  todos: Todo[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

export function TodoList({ todos, onToggle, onDelete }: TodoListProps) {
  if (todos.length === 0) {
    return <p className="empty">No todos yet. Add one above!</p>;
  }

  return (
    <ul className="todo-list">
      {todos.map((todo) => (
        <li key={todo.id} className={todo.completed ? "completed" : ""}>
          <label>
            <input
              type="checkbox"
              checked={!!todo.completed}
              onChange={() => onToggle(todo.id)}
            />
            <span className="todo-text">{todo.text}</span>
          </label>
          <button
            className="delete-btn"
            onClick={() => onDelete(todo.id)}
            aria-label="Delete"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
