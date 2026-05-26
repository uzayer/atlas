interface Props {
  hours: number[]; // length 24
  active?: boolean;
}

export function HourHistogram({ hours, active }: Props) {
  const peak = Math.max(1, ...hours);
  return (
    <div className="flex items-end gap-[1px] h-6 w-full">
      {hours.map((m, i) => {
        const h = m === 0 ? 2 : Math.max(3, Math.round((m / peak) * 20));
        return (
          <div
            key={i}
            className="flex-1 rounded-[1px] transition-colors"
            style={{
              height: h,
              background:
                m === 0
                  ? "var(--border-default)"
                  : active
                    ? "var(--text-primary)"
                    : "var(--text-tertiary)",
              opacity: m === 0 ? 0.5 : 1,
            }}
          />
        );
      })}
    </div>
  );
}
