// A dense table that scrolls sideways inside its panel (focusable, so keyboard users can scroll it). With `onRow`, the
// first cell becomes a button and the whole row is clickable.
import type { ReactNode } from "react";

export interface DenseCol<T> {
  key: string;
  label: ReactNode;
  render: (r: T) => ReactNode;
  align?: "right" | "center";
  className?: string;
}

export function DenseTable<T>({
  rows,
  cols,
  label,
  onRow,
  rowLabel,
  minWidth = 560,
}: {
  rows: T[];
  cols: DenseCol<T>[];
  label: string;
  onRow?: (r: T) => void;
  rowLabel?: (r: T) => string;
  minWidth?: number;
}) {
  const al = (a?: "right" | "center") =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";
  return (
    <div
      className="relative w-full max-w-full overflow-x-auto px-1"
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-line text-xs text-ink-3">
            {cols.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`whitespace-nowrap px-2 py-2 font-medium ${al(c.align)}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              className={`border-b border-line-2 last:border-0 ${onRow ? "row-hover cursor-pointer" : ""}`}
              onClick={onRow ? () => onRow(r) : undefined}
            >
              {cols.map((c, ci) => (
                <td key={c.key} className={`px-2 py-2.5 align-middle ${al(c.align)} ${c.className ?? ""}`}>
                  {onRow && ci === 0 ? (
                    <button type="button" className="block max-w-full text-left">
                      {rowLabel && <span className="sr-only">{rowLabel(r)}: </span>}
                      {c.render(r)}
                    </button>
                  ) : (
                    c.render(r)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
