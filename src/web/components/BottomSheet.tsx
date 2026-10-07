// 공용 바텀시트 — 딤 오버레이 + 상단 라운드 + 타이틀. overlay 클릭/ESC로 닫는다.
// 정렬·필터 등 선택 UI에 재사용한다 (옵션 선택은 다음 단계에서 같은 패턴 적용 예정).
import { useEffect } from "react";

export function BottomSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <b className="sheet-title">{title}</b>
          <button className="sheet-close" aria-label="닫기" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
