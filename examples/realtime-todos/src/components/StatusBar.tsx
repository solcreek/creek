import { useRoom } from "creek/react";

export function StatusBar() {
  const { isConnected, peers } = useRoom();

  return (
    <div className="status-bar">
      <span className={`dot ${isConnected ? "connected" : "disconnected"}`} />
      <span className="status-text">
        {isConnected
          ? peers > 1
            ? `${peers} viewers`
            : "Only you"
          : "Connecting..."}
      </span>
    </div>
  );
}
