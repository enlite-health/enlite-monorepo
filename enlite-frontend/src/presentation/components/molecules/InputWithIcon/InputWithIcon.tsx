import { InputHTMLAttributes, ReactNode, forwardRef } from 'react';
import { Text } from '@presentation/components/atoms/Text';

interface InputWithIconProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode;
  iconPosition?: 'left' | 'right';
  error?: string;
  borderColor?: string;
  /** 'default' = h-60 (forms); 'compact' = h-48 (alinha com o Select do design system) */
  inputSize?: 'default' | 'compact';
}

export const InputWithIcon = forwardRef<HTMLInputElement, InputWithIconProps>(
  function InputWithIcon(
    {
      icon,
      iconPosition = 'right',
      error,
      borderColor = '#D9D9D9',
      inputSize = 'default',
      className = '',
      ...props
    },
    ref
  ): JSX.Element {
  const borderClass = error ? 'border-red-500' : `border-[${borderColor}]`;
  const isCompact = inputSize === 'compact';
  const boxClass = isCompact ? 'h-12 px-4 border-[1.5px]' : 'h-[60px] px-5 border-2';
  const textClass = isCompact ? 'text-sm' : 'text-[20px]';

  return (
    <div className="flex flex-col gap-1 w-full">
      <div
        className={`flex items-center ${boxClass} rounded-[10px] border-solid ${borderClass} bg-white gap-2 focus-within:border-[#180149] transition-colors ${className}`}
      >
        {iconPosition === 'left' && icon && (
          <span className="flex items-center shrink-0">{icon}</span>
        )}
        <input
          ref={ref}
          className={`flex-1 w-full border-none outline-none font-['Lexend'] font-medium ${textClass} leading-[1.3] text-[#737373] bg-transparent placeholder:text-[#737373]/60`}
          {...props}
        />
        {iconPosition === 'right' && icon && (
          <span className="flex items-center shrink-0">{icon}</span>
        )}
      </div>
      {error && <Text size="xs" color="inherit" className="text-red-500">{error}</Text>}
    </div>
  );
  }
);
