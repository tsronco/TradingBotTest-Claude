interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Inline SVG sparkline. Auto-scales to data range. Color is positive (green)
 * if last >= first, negative (red) otherwise. Renders nothing if values
 * has fewer than 2 points.
 */
export default function Sparkline({
  values,
  width = 280,
  height = 56,
  className = '',
}: SparklineProps) {
  const cleaned = values.filter((v) => Number.isFinite(v));
  if (cleaned.length < 2) {
    return (
      <div
        className={`text-muted text-[10px] flex items-center justify-center ${className}`}
        style={{ width, height }}
      >
        no equity history yet
      </div>
    );
  }
  const min = Math.min(...cleaned);
  const max = Math.max(...cleaned);
  const range = max - min || 1;
  const stepX = width / (cleaned.length - 1);
  const points = cleaned.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = `M ${points.join(' L ')}`;
  const areaPath = `${path} L ${width.toFixed(1)},${height} L 0,${height} Z`;
  const positive = cleaned[cleaned.length - 1] >= cleaned[0];
  const stroke = positive ? '#5cd97e' : '#ff6b6b';
  const fill = positive ? 'rgba(92, 217, 126, 0.12)' : 'rgba(255, 107, 107, 0.12)';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      preserveAspectRatio="none"
    >
      <path d={areaPath} fill={fill} />
      <path d={path} stroke={stroke} strokeWidth={1.5} fill="none" />
    </svg>
  );
}
