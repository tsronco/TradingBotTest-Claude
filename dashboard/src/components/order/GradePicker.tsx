// dashboard/src/components/order/GradePicker.tsx
import { GRADE_LETTERS, type GradeLetter } from '../../lib/trade-types';

export function GradePicker({ value, onChange }: { value: GradeLetter | null; onChange: (g: GradeLetter) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {GRADE_LETTERS.map((g) => (
        <button
          key={g}
          type="button"
          onClick={() => onChange(g)}
          className={`px-2 py-0.5 border text-[12px] tnum ${
            value === g
              ? 'border-hi text-hi bg-hi/5 font-semibold'
              : 'border-border text-mid bg-panel'
          }`}
        >
          {g}
        </button>
      ))}
    </div>
  );
}
