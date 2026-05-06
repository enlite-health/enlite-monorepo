import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { ChevronDown } from 'lucide-react';

interface TimeSelectProps {
  value?: string;
  onChange?: (e: { target: { value: string } }) => void;
  step?: 15 | 30 | 60;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  /**
   * Adds `23:59` (last canonical minute of the day) as the final option.
   * Use it on *end* time inputs to cover the tail between the last `step`
   * boundary and midnight. We deliberately avoid `24:00` because it isn't
   * a valid HH:mm value — Postgres `time`, `Date`, Zod time validators and
   * most libs reject it, which would force special-casing across the codebase.
   */
  includeEndOfDay?: boolean;
}

const END_OF_DAY = '23:59';

function generateOptions(step: number, includeEndOfDay: boolean): string[] {
  const intervals = (24 * 60) / step;
  const opts = Array.from({ length: intervals }, (_, i) => {
    const totalMinutes = i * step;
    const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const minutes = String(totalMinutes % 60).padStart(2, '0');
    return `${hours}:${minutes}`;
  });
  return includeEndOfDay ? [...opts, END_OF_DAY] : opts;
}

function normalizeTime(val: string): string {
  if (!val) return '';
  return val.slice(0, 5);
}

export function TimeSelect({
  value = '',
  onChange,
  step = 30,
  className = '',
  disabled = false,
  placeholder = '--:--',
  includeEndOfDay = false,
}: TimeSelectProps) {
  const normalized = normalizeTime(value);
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const options = generateOptions(step, includeEndOfDay);

  const close = useCallback(() => setOpen(false), []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  // Decide direction + scroll to selected value
  useLayoutEffect(() => {
    if (!open || !containerRef.current || !listRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const LIST_HEIGHT = 240;
    setOpenUp(spaceBelow < LIST_HEIGHT);

    if (!normalized) return;
    const index = options.indexOf(normalized);
    if (index < 0) return;
    const item = listRef.current.children[index] as HTMLElement | undefined;
    if (item) {
      listRef.current.scrollTop = item.offsetTop - LIST_HEIGHT / 2 + item.offsetHeight / 2;
    }
  }, [open, normalized, options]);

  const select = (time: string) => {
    onChange?.({ target: { value: time } });
    close();
  };

  const hour = (time: string) => parseInt(time.split(':')[0], 10);

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={[
          'flex items-center gap-1 cursor-pointer select-none',
          disabled ? 'opacity-50 cursor-not-allowed' : '',
          className,
        ].join(' ')}
      >
        <span>{normalized || placeholder}</span>
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <ul
          ref={listRef}
          style={{ maxHeight: 240 }}
          className={[
            'absolute z-50 w-28 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl py-1',
            openUp ? 'bottom-full mb-1' : 'top-full mt-1',
          ].join(' ')}
        >
          {options.map((time, i) => {
            const showDivider = i > 0 && step < 60 && hour(time) !== hour(options[i - 1]);
            return (
              <li key={time}>
                {showDivider && <hr className="my-0.5 border-gray-100" />}
                <button
                  type="button"
                  onClick={() => select(time)}
                  className={[
                    'w-full px-3 py-1.5 text-sm text-center tabular-nums transition-colors',
                    time === normalized
                      ? 'bg-primary text-white font-semibold'
                      : 'text-gray-700 hover:bg-primary/10 hover:text-primary',
                  ].join(' ')}
                >
                  {time}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
