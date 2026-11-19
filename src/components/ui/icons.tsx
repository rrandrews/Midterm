/* Filled-dot icons from the mockup that have no exact lucide equivalent. */

type IconProps = { size?: number };

const DOT_POSITIONS = [6, 12, 18];

/** Six-dot drag grip. */
export function GripIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {DOT_POSITIONS.flatMap((cy) => [
        <circle key={`l${cy}`} cx="9" cy={cy} r="1.5" />,
        <circle key={`r${cy}`} cx="15" cy={cy} r="1.5" />,
      ])}
    </svg>
  );
}

/** Three horizontal dots ("more"). */
export function DotsIcon({ size = 12, radius = 1.8 }: IconProps & { radius?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r={radius} />
      <circle cx="12" cy="12" r={radius} />
      <circle cx="19" cy="12" r={radius} />
    </svg>
  );
}
