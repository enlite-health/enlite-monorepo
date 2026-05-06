import { SelectHTMLAttributes, forwardRef, type ChangeEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { Text as BodyText } from '@presentation/components/atoms/Text';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  options: SelectOption[];
  error?: string;
  placeholder?: string;
  borderColor?: string;
  onChange?: (value: string) => void;
  label?: string;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(
  function SelectField(
    {
      options,
      error,
      placeholder = 'Selecione',
      borderColor = '#D9D9D9',
      className = '',
      onChange,
      label,
      ...props
    },
    ref
  ): JSX.Element {
    const borderClass = error ? 'border-red-500' : `border-[${borderColor}]`;

    const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
      onChange?.(event.target.value);
    };

    return (
      <div className="flex flex-col gap-1 w-full">
        <div
          className={`flex items-center h-[60px] px-5 rounded-[10px] border-2 border-solid ${borderClass} bg-white focus-within:border-[#180149] transition-colors ${className}`}
        >
          <div className="flex justify-between w-full items-center relative">
            <select
              ref={ref}
              className="w-full font-['Lexend'] font-medium text-[20px] leading-[1.3] text-[#737373] bg-transparent outline-none appearance-none pr-8 cursor-pointer relative z-10"
              onChange={handleChange}
              {...props}
            >
              <option value="">{placeholder}</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown size={20} className="absolute right-0 text-[#737373] pointer-events-none z-0" />
          </div>
        </div>
        {error && <BodyText size="xs" color="inherit" className="text-red-500">{error}</BodyText>}
      </div>
    );
  }
);
