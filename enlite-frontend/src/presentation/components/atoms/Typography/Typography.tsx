import { ReactNode } from 'react';

type TypographyVariant =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'body'
  | 'caption'
  | 'label'
  | 'card-title'
  | 'section-title'
  | 'value'
  | 'value-sm'
  | 'day-name';

type TypographyWeight = 'normal' | 'medium' | 'semibold' | 'bold';
type TypographyColor = 'primary' | 'secondary' | 'tertiary' | 'white';

interface TypographyProps {
  variant?: TypographyVariant;
  weight?: TypographyWeight;
  color?: TypographyColor;
  children: ReactNode;
  className?: string;
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'span' | 'label';
}

const variantStyles: Record<TypographyVariant, string> = {
  h1: 'font-poppins text-2xl leading-tight',
  h2: 'font-poppins text-xl leading-tight',
  h3: 'font-poppins text-lg leading-tight',
  body: 'font-lexend text-sm leading-snug',
  caption: 'font-lexend text-xs leading-relaxed',
  label: 'font-lexend text-base leading-[150%]',
  'card-title': 'font-lexend text-[28px] leading-[1.3]',
  'section-title': 'font-lexend text-[22px] leading-[1.3]',
  value: 'font-lexend text-[22px] leading-[1.3]',
  'value-sm': 'font-lexend text-[18px] leading-[1.3]',
  'day-name': 'font-lexend text-sm leading-[1.4]',
};

const weightStyles: Record<TypographyWeight, string> = {
  normal: 'font-normal',
  medium: 'font-medium',
  semibold: 'font-semibold',
  bold: 'font-bold',
};

const colorStyles: Record<TypographyColor, string> = {
  primary: 'text-primary',
  secondary: 'text-gray-800',
  tertiary: 'text-[#374151]',
  white: 'text-white',
};

export function Typography({
  variant = 'body',
  weight = 'normal',
  color = 'secondary',
  children,
  className = '',
  as,
}: TypographyProps): JSX.Element {
  const isHeading = variant === 'h1' || variant === 'h2' || variant === 'h3';
  const Component = as || (isHeading ? (variant as 'h1' | 'h2' | 'h3') : 'p');
  
  return (
    <Component
      className={`${variantStyles[variant]} ${weightStyles[weight]} ${colorStyles[color]} ${className}`}
    >
      {children}
    </Component>
  );
}
