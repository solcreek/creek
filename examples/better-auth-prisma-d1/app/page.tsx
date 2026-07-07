"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import { signUp, signIn, signOut, useSession } from "@/lib/auth-client";

// Minimal email/password UI. The point of this example: Better Auth's session
// and user storage run on Cloudflare D1 (via Prisma) once deployed with Creek —
// with no change to this code.
export default function Home() {
  const { data: session, isPending } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (isPending) return <main style={S.main}>Loading…</main>;

  if (session?.user) {
    return (
      <main style={S.main}>
        <h1>Signed in</h1>
        <p>
          {session.user.name} &lt;{session.user.email}&gt;
        </p>
        <button style={S.btn} onClick={() => signOut()}>
          Sign out
        </button>
      </main>
    );
  }

  return (
    <main style={S.main}>
      <h1>Better Auth + Prisma on D1</h1>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <input
        style={S.in}
        placeholder="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        style={S.in}
        placeholder="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        style={S.in}
        type="password"
        placeholder="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button
          style={S.btn}
          onClick={async () => {
            setError(null);
            const r = await signUp.email({ email, password, name });
            if (r.error) setError(r.error.message ?? "sign-up failed");
          }}
        >
          Sign up
        </button>
        <button
          style={S.btn}
          onClick={async () => {
            setError(null);
            const r = await signIn.email({ email, password });
            if (r.error) setError(r.error.message ?? "sign-in failed");
          }}
        >
          Sign in
        </button>
      </div>
    </main>
  );
}

const S: Record<string, CSSProperties> = {
  main: {
    maxWidth: 360,
    margin: "64px auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    fontFamily: "system-ui",
  },
  in: { padding: 8, border: "1px solid #ccc", borderRadius: 6 },
  btn: { padding: "8px 16px", borderRadius: 6, border: "1px solid #333", cursor: "pointer" },
};
