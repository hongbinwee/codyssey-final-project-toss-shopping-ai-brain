export function Loading({ text = "불러오는 중…" }: { text?: string }) {
  return <div className="state-box">{text}</div>;
}
export function Empty({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="state-box">
      <p>{text}</p>
      {action}
    </div>
  );
}
export function ErrorState({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="state-box error">
      <p>{text}</p>
      {onRetry && (
        <button className="btn ghost" onClick={onRetry}>다시 시도</button>
      )}
    </div>
  );
}

