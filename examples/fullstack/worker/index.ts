import { db, kv } from "creek";

// This is the user's server code.
// `db` and `kv` are imported like normal modules — no env wiring needed.

async function handleApi(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // GET /api/todos — list all todos
  if (url.pathname === "/api/todos" && request.method === "GET") {
    const result = await db
      .prepare("SELECT * FROM todos ORDER BY created_at DESC")
      .all();

    // Track visit count in KV
    const visits = parseInt((await kv.get("visit_count")) ?? "0") + 1;
    await kv.put("visit_count", String(visits));

    return Response.json({
      todos: result.results,
      visits,
    });
  }

  // POST /api/todos — create a todo
  if (url.pathname === "/api/todos" && request.method === "POST") {
    const body = await request.json<{ title: string }>();
    if (!body.title) {
      return Response.json({ error: "title is required" }, { status: 400 });
    }

    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO todos (id, title, completed) VALUES (?, ?, 0)",
      )
      .bind(id, body.title)
      .run();

    return Response.json({ id, title: body.title, completed: false }, { status: 201 });
  }

  // DELETE /api/todos/:id
  if (url.pathname.startsWith("/api/todos/") && request.method === "DELETE") {
    const id = url.pathname.split("/").pop();
    await db.prepare("DELETE FROM todos WHERE id = ?").bind(id!).run();
    return Response.json({ ok: true });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

// This export is what Creek deploys as the user worker.
// The generated wrapper calls _setEnv(env) before this runs.
export { handleApi };

