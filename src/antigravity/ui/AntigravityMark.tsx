/*
 * Geometric Antigravity emblem: orbital ring + rising core in `accent`
 * (pulses gently while a turn runs). Strictly token-colored via CSS.
 */

export function AntigravityMark({ size = 14, running = false }: { size?: number; running?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={`ag-mark${running ? " is-running" : ""}`}
      aria-hidden="true"
    >
      <ellipse cx="12" cy="13.5" rx="9" ry="4.5" stroke="currentColor" strokeWidth="1.6" opacity="0.55" transform="rotate(-18 12 13.5)" />
      <path d="M12 4.5L16.5 14.5H7.5L12 4.5Z" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
      <circle cx="12" cy="11.5" r="1.6" fill="currentColor" />
    </svg>
  );
}
