import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div style={{ fontFamily: "system-ui", padding: "2rem", textAlign: "center" }}>
      <h1>Hello from Loopix!</h1>
      <p>Deployed with loopix deploy</p>
      <button onClick={() => setCount(c => c + 1)}>
        Count: {count}
      </button>
    </div>
  );
}
