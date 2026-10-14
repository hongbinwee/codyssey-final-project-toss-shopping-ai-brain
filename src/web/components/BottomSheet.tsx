// 공용 바텀시트 — 딤 오버레이 + 상단 라운드 + 타이틀. overlay 클릭/ESC로 닫는다.
// 정렬·필터 등 선택 UI에 재사용한다 (옵션 선택은 다음 단계에서 같은 패턴 적용 예정).
import { useEffect } from "react";
import { IcClose } from "../icons.tsx";

export function BottomSheet({
  title,
  onClose,
  className,
  lockScroll,
  children,
}: {
  title: string;
  onClose: () => void;
  // 스코프 선택지 — 배송 시트처럼 본문 스크롤+고정 CTA가 필요한 시트만
  // className으로 scoped override를 받는다. lockScroll은 배경 스크롤을
  // 잠그고 언마운트 시 기존 값으로 복원한다(다른 시트는 기본 미적용) [PMQA-068].
  className?: string;
  lockScroll?: boolean;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!lockScroll) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [lockScroll]);

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div
        className={"sheet" + (className ? " " + className : "")}
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grabber" aria-hidden />
        <div className="sheet-head">
          <b className="sheet-title">{title}</b>
          <button className="sheet-close" aria-label="닫기" onClick={onClose}>
            <IcClose size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
