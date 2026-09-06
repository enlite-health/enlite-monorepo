import { InputHTMLAttributes, ReactNode } from 'react';

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  labelContent?: ReactNode;
  error?: string;
}

export function Checkbox({
  label,
  labelContent,
  error,
  checked,
  onChange,
  className = '',
  id,
  ...props
}: CheckboxProps): JSX.Element {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {/* `min-h-6` = 24px, o mínimo de alvo da WCAG 2.5.8. Sem rótulo o label
          media 22px (2px do mt-0.5 + 20px da caixa) e ficava 2px abaixo da
          régua; com rótulo já passava de 24px, então isto não muda nada lá. */}
      <label htmlFor={id} className="flex min-h-6 items-start gap-3 cursor-pointer group">
        <div className="relative mt-0.5 shrink-0">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={onChange}
            className="sr-only"
            {...props}
          />
          <div
            className={`w-5 h-5 rounded-[5px] border-2 flex items-center justify-center transition-all ${
              checked
                ? 'bg-primary border-primary'
                : error
                  ? 'bg-white border-red-500'
                  : 'bg-white border-gray-600 group-hover:border-primary'
            }`}
          >
            {checked && (
              <svg
                width="11"
                height="8"
                viewBox="0 0 11 8"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M1 3.5L4 6.5L10 1"
                  stroke="white"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        </div>
        {labelContent ? (
          <div className={`font-lexend text-xs leading-relaxed select-none ${error ? 'text-red-500' : 'text-gray-800'}`}>
            {labelContent}
          </div>
        ) : label ? (
          <span className={`font-lexend text-xs leading-relaxed select-none ${error ? 'text-red-500' : 'text-gray-800'}`}>
            {label}
          </span>
        ) : null}
      </label>
      {error && <span className="text-red-500 text-xs ml-8">{error}</span>}
    </div>
  );
}
