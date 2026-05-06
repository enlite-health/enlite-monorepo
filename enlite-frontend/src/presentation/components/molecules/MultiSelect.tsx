import { useState, useRef, useEffect } from 'react';
import { Text } from '@presentation/components/atoms/Text';

interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectProps {
  options: MultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  error?: string;
  label?: string;
  testId?: string;
}

export function MultiSelect({ options, value, onChange, placeholder, error, label, testId }: MultiSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleOption = (optionValue: string): void => {
    if (value.includes(optionValue)) {
      onChange(value.filter((v) => v !== optionValue));
    } else {
      onChange([...value, optionValue]);
    }
  };

  const getDisplayText = (): string => {
    if (value.length === 0) return placeholder || 'Selecione';
    const selectedLabels = value.map((v) => options.find((o) => o.value === v)?.label).filter(Boolean);
    return selectedLabels.join(', ');
  };

  return (
    <div className="flex flex-col gap-1 flex-1 grow" ref={containerRef}>
      {label && (
        <Text size="base" color="tertiary" as="span" className="relative w-fit mt-[-1.00px]">
          {label}
        </Text>
      )}
      <div className="relative">
        <div
          onClick={() => setIsOpen(!isOpen)}
          data-testid={testId ? `${testId}-trigger` : undefined}
          className="flex items-center h-12 px-4 relative w-full rounded-[10px] border-[1.5px] border-solid border-[#D9D9D9] focus-within:border-primary transition-colors bg-white cursor-pointer"
        >
          <div className="flex justify-between w-full items-center relative">
            <Text
              size="sm"
              weight="medium"
              color="inherit"
              className={value.length === 0 ? 'text-gray-600' : 'text-[#374151]'}
            >
              {getDisplayText()}
            </Text>
            <img
              className={`w-3 h-[7px] pointer-events-none transition-transform ${isOpen ? 'rotate-180' : ''}`}
              alt="Vector"
              src="https://c.animaapp.com/Bbli6X7n/img/vector-9.svg"
            />
          </div>
        </div>

        {isOpen && (
          <div
            data-testid={testId ? `${testId}-dropdown` : undefined}
            className="absolute z-50 w-full mt-1 bg-white border-[1.5px] border-solid border-[#D9D9D9] rounded-[10px] shadow-lg max-h-60 overflow-y-auto"
          >
            {options.map((option) => (
              <div
                key={option.value}
                onClick={() => toggleOption(option.value)}
                className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
              >
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${value.includes(option.value) ? 'bg-primary border-primary' : 'border-gray-600'}`}>
                  {value.includes(option.value) && (
                    <svg width="12" height="9" viewBox="0 0 12 9" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M1 4.5L4.5 8L11 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
                <Text size="sm" weight="medium" color="tertiary">{option.label}</Text>
              </div>
            ))}
          </div>
        )}
      </div>
      {error && <Text size="xs" color="inherit" className="text-red-500">{error}</Text>}
    </div>
  );
}
