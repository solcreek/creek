import { useState } from "react";

interface ShareButtonProps {
  roomId: string;
}

export function ShareButton({ roomId }: ShareButtonProps) {
  const [copied, setCopied] = useState(false);

  const shareUrl = `${window.location.origin}/?room=${roomId}`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button className="share-btn" onClick={handleCopy}>
      {copied ? "Copied!" : "Share live session"}
    </button>
  );
}
