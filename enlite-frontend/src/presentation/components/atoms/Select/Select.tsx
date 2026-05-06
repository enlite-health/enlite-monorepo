import { forwardRef, SelectHTMLAttributes, ChangeEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  inputWrapperClasses,
  INPUT_SIZE_CONFIG,
  type InputSize,
} from '../Input/inputClasses';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'size'> {
  options: SelectOption[];
  placeholder?: string;
  error?: string;
  inputSize?: InputSize;
  /** Atalho para Controller do RHF: recebe o valor já tipado como string */
  onValueChange?: (value: string) => void;
  onChange?: SelectHTMLAttributes<HTMLSelectElement>['onChange'];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select(
    {
      options,
      placeholder,
      error,
      inputSize = 'default',
      disabled,
      onValueChange,
      onChange,
      value,
      className = '',
      ...props
    },
    ref
  ) {
    const config = INPUT_SIZE_CONFIG[inputSize];

    const handleChange = (e: ChangeEvent<HTMLSelectElement>): void => {
      onValueChange?.(e.target.value);
      onChange?.(e);
    };

    const innerSelectClasses = [
      'w-full bg-transparent outline-none appearance-none pr-8 cursor-pointer',
      "font-['Lexend'] font-medium text-[#737373]",
      config.fontSize,
      config.lineHeight,
      disabled ? 'cursor-not-allowed' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        className={`relative ${inputWrapperClasses({ size: inputSize, error: !!error, disabled })} ${className}`}
      >
        <select
          ref={ref}
          disabled={disabled}
          aria-invalid={!!error}
          value={value}
          onChange={handleChange}
          className={innerSelectClasses}
          {...props}
        >
          {placeholder !== undefined && (
            <option value="" disabled={!!value} hidden={!!value}>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={20}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-[#737373] pointer-events-none"
        />
      </div>
    );
  }
);
