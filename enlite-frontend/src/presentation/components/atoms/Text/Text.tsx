import { ReactNode } from 'react';

type TextSize = 'xs' | 'sm' | 'base' | 'lg' | 'xl';
type TextWeight = 'normal' | 'medium' | 'semibold' | 'bold';
type TextColor =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'muted'
  | 'white'
  | 'inherit';

interface TextProps {
  size?: TextSize;
  weight?: TextWeight;
  color?: TextColor;
  children: ReactNode;
  className?: string;
  as?: 'p' | 'span' | 'div';
  title?: string;
}

const sizeStyles: Record<TextSize, string> = {
  xs: 'text-xs leading-[1.5]',
  sm: 'text-sm leading-snug',
  base: 'text-base leading-[1.5]',
  lg: 'text-lg leading-[1.4]',
  xl: 'text-xl leading-[1.3]',
};

const weightStyles: Record<TextWeight, string> = {
  normal: 'font-normal',
  medium: 'font-medium',
  semibold: 'font-semibold',
  bold: 'font-bold',
};

const colorStyles: Record<TextColor, string> = {
  primary: 'text-primary',
  secondary: 'text-gray-800',
  tertiary: 'text-[#374151]',
  muted: 'text-gray-700',
  white: 'text-white',
  inherit: '',
};

export function Text({
  size = 'sm',
  weight = 'normal',
  color = 'secondary',
  children,
  className = '',
  as = 'p',
  title,
}: TextProps): JSX.Element {
  const Component = as;
  const classes = [
    'font-lexend',
    sizeStyles[size],
    weightStyles[weight],
    colorStyles[color],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Component className={classes} title={title}>
      {children}
    </Component>
  );
}
