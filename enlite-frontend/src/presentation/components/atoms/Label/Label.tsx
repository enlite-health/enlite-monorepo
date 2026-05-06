import { LabelHTMLAttributes, ReactNode } from 'react';

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  children: ReactNode;
  required?: boolean;
  optional?: boolean;
}

export function Label({
  children,
  required = false,
  optional = false,
  className = '',
  ...props
}: LabelProps): JSX.Element {
  return (
    <label
      className={`font-['Lexend'] font-medium text-[18px] leading-[1.3] text-[#737373] ${className}`}
      {...props}
    >
      {children}
      {required && <span className="text-red-500 ml-1">*</span>}
      {optional && (
        <span className="font-normal text-xs text-[#b0b0b0] ml-2">(opcional)</span>
      )}
    </label>
  );
}
