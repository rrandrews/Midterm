/*
 * Claude Code's mark: a small asterisk of tapered rays in `accent`. It
 * pulses while a turn runs and is still otherwise.
 */

const RAYS = 8;

export function ClaudeMark({ running = false, size = 13 }: { running?: boolean; size?: number }) {
  return (
    <svg className={`cc-mark${running ? " is-running" : ""}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {Array.from({ length: RAYS }, (_, index) => (
        <path key={index} d="M12 12 L10.9 3.2 Q12 1.6 13.1 3.2 Z" transform={`rotate(${(360 / RAYS) * index + (index % 2 ? 4 : 0)} 12 12)`} />
      ))}
      <circle cx="12" cy="12" r="2.1" />
    </svg>
  );
}
