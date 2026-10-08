// 공용 SVG 아이콘 — 24x24 그리드, stroke 2, round cap/join. 색은 currentColor 상속.
// 토스 고유 아이콘 복제가 아니라 범용 라인 아이콘을 동일 규격으로 통일한 것.
type P = { size?: number; className?: string };
const Svg = ({ size = 22, className, children }: P & { children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className={className}
  >
    {children}
  </svg>
);

export const IcSearch = (p: P) => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><line x1="16.2" y1="16.2" x2="21" y2="21" /></Svg>
);
export const IcCart = (p: P) => (
  <Svg {...p}><path d="M5.5 8h13l-1.1 12.2a1 1 0 0 1-1 .8H7.6a1 1 0 0 1-1-.8L5.5 8Z" /><path d="M9 10V7a3 3 0 0 1 6 0v3" /></Svg>
);
export const IcBack = (p: P) => <Svg {...p}><polyline points="14.5 4.5 7 12 14.5 19.5" /></Svg>;
export const IcClose = (p: P) => (
  <Svg {...p}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></Svg>
);
export const IcHome = (p: P) => (
  <Svg {...p}><path d="M4 11.2 12 4l8 7.2V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1v-8.8Z" /></Svg>
);
export const IcReceipt = (p: P) => (
  <Svg {...p}><path d="M7 3.5h10V21l-2.5-1.6L12 21l-2.5-1.6L7 21V3.5Z" /><line x1="9.5" y1="8.5" x2="14.5" y2="8.5" /><line x1="9.5" y1="12" x2="14.5" y2="12" /></Svg>
);
export const IcSparkle = (p: P) => (
  <Svg {...p}><path d="M12 3.5 14 9.5 20 11.5 14 13.5 12 19.5 10 13.5 4 11.5 10 9.5 12 3.5Z" /></Svg>
);
export const IcClock = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="8" /><polyline points="12 7.5 12 12 15 14" /></Svg>
);
export const IcChevronDown = (p: P) => <Svg {...p}><polyline points="5.5 9 12 15.5 18.5 9" /></Svg>;
export const IcCheck = (p: P) => <Svg {...p}><polyline points="4.5 12.5 10 18 19.5 6.5" /></Svg>;
export const IcStar = ({ size = 13, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden className={className}>
    <path d="M12 2.8 15 8.7l6.4.9-4.7 4.4 1.2 6.3L12 17.2 6.1 20.3l1.2-6.3L2.6 9.6l6.4-.9L12 2.8Z" />
  </svg>
);

// ── 04-C 홈 재구성 아이콘 — 같은 24px/stroke2 규격의 범용 라인 아이콘 ──
export const IcUser = (p: P) => (
  <Svg {...p}><circle cx="12" cy="8" r="3.6" /><path d="M5 20.2c1.4-3.8 4-5.7 7-5.7s5.6 1.9 7 5.7" /></Svg>
);
export const IcChevronRight = (p: P) => <Svg {...p}><polyline points="9 5.5 16.5 12 9 18.5" /></Svg>;
export const IcGrid = (p: P) => (
  <Svg {...p}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></Svg>
);
export const IcTag = (p: P) => (
  <Svg {...p}><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h5.4a2 2 0 0 1 1.4.6l7.5 7.5a2 2 0 0 1 0 2.8l-5 5a2 2 0 0 1-2.9 0L4.5 12.4A2 2 0 0 1 4 11V5.5Z" /><circle cx="8.3" cy="8.3" r="1.1" /></Svg>
);
export const IcDrop = (p: P) => (
  <Svg {...p}><path d="M12 3.5s5.8 6.6 5.8 10.7a5.8 5.8 0 0 1-11.6 0C6.2 10.1 12 3.5 12 3.5Z" /></Svg>
);
export const IcCup = (p: P) => (
  <Svg {...p}><path d="M5.5 9.5h10.5v5.3a5.3 5.3 0 0 1-10.5 0V9.5Z" /><path d="M16 10.5h2a2.6 2.6 0 0 1 0 5.2h-2" /><line x1="8.5" y1="4" x2="8.5" y2="6.5" /><line x1="12.5" y1="4" x2="12.5" y2="6.5" /></Svg>
);
export const IcMonitor = (p: P) => (
  <Svg {...p}><rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="16" x2="12" y2="20" /></Svg>
);
export const IcBulb = (p: P) => (
  <Svg {...p}><path d="M6.5 4h11l3 7.5h-17L6.5 4Z" /><line x1="12" y1="11.5" x2="12" y2="18.5" /><line x1="8" y1="18.5" x2="16" y2="18.5" /></Svg>
);
export const IcShirt = (p: P) => (
  <Svg {...p}><path d="M8.5 3.5 4 7l1.8 3.2 1.7-.9V20h9V9.3l1.7.9L20 7l-4.5-3.5-1.7 1.8h-3.6L8.5 3.5Z" /></Svg>
);

