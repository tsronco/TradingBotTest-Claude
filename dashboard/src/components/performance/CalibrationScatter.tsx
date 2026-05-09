interface Point { trade_id: string; user_grade: number; ai_grade: number; }
interface Props { data: Point[]; }

export default function CalibrationScatter({ data }: Props) {
  if (!data.length) {
    return <div className="text-dim text-[11px]">no graded trades yet</div>;
  }
  const W = 320, H = 220, P = 30;
  const min = 0, max = 11;
  const x = (g: number) => P + ((g - min) / (max - min)) * (W - 2 * P);
  const y = (g: number) => H - P - ((g - min) / (max - min)) * (H - 2 * P);

  const meanDelta = data.reduce((s, d) => s + (d.user_grade - d.ai_grade), 0) / data.length;

  return (
    <div>
      <svg width={W} height={H} className="block">
        <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="rgba(255,255,255,0.2)" />
        <line x1={P} y1={P} x2={P} y2={H - P} stroke="rgba(255,255,255,0.2)" />
        <line x1={x(min)} y1={y(min)} x2={x(max)} y2={y(max)} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
        <text x={W / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="rgba(255,255,255,0.5)">your grade →</text>
        <text x={10} y={H / 2} textAnchor="middle" fontSize="10" fill="rgba(255,255,255,0.5)" transform={`rotate(-90 10 ${H / 2})`}>← AI grade</text>
        {data.map((d, i) => (
          <circle key={`${d.trade_id}-${i}`} cx={x(d.user_grade)} cy={y(d.ai_grade)} r="3.5" fill="#22d3ee" opacity="0.7" />
        ))}
      </svg>
      <div className="text-[10px] text-dim mt-2">
        n = {data.length}. Mean delta: <span className={meanDelta < -0.5 ? 'text-amber' : meanDelta > 0.5 ? 'text-cyan' : 'text-hi'}>
          {meanDelta >= 0 ? '+' : ''}{meanDelta.toFixed(2)}
        </span>
        {meanDelta < -0.5 ? ' — you grade higher than AI'
          : meanDelta > 0.5 ? ' — you grade lower than AI'
          : ' — well calibrated'}
      </div>
    </div>
  );
}
