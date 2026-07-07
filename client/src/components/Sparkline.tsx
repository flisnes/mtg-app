// Tiny inline price sparkline. Green if the latest value is ≥ the first.

export function Sparkline({ values, width = 84, height = 26 }: { values: number[]; width?: number; height?: number }) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return <span className="spark-empty">—</span>;

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const step = width / (clean.length - 1);
  const points = clean
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * (height - 2) - 1).toFixed(1)}`)
    .join(' ');
  const up = clean[clean.length - 1]! >= clean[0]!;

  return (
    <svg
      className={`spark ${up ? 'spark-up' : 'spark-down'}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline points={points} fill="none" strokeWidth="1.5" />
    </svg>
  );
}
