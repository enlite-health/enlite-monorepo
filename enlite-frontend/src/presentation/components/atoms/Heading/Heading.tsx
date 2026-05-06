import { ReactNode } from 'react';

type HeadingLevel = 1 | 2 | 3 | 4;
type HeadingWeight = 'medium' | 'semibold' | 'bold';
type HeadingColor = 'primary' | 'secondary' | 'tertiary' | 'white' | 'inherit';

interface HeadingProps {
  level?: HeadingLevel;
  weight?: HeadingWeight;
  color?: HeadingColor;
  children: ReactNode;
  className?: string;
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  id?: string;
}

const levelStyles: Record<HeadingLevel, string> = {
  1: 'text-2xl leading-tight',
  2: 'text-xl leading-tight',
  3: 'text-lg leading-snug',
  4: 'text-base leading-snug',
};

const weightStyles: Record<HeadingWeight, string> = {
  medium: 'font-medium',
  semibold: 'font-semibold',
  bold: 'font-bold',
};

const colorStyles: Record<HeadingColor, string> = {
  primary: 'text-primary',
  secondary: 'text-gray-800',
  tertiary: 'text-[#374151]',
  white: 'text-white',
  inherit: '',
};

export function Heading({
  level = 1,
  weight = 'semibold',
  color = 'primary',
  children,
  className = '',
  as,
  id,
}: HeadingProps): JSX.Element {
  const Component = (as || (`h${level}` as const)) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  const classes = [
    'font-poppins',
    levelStyles[level],
    weightStyles[weight],
    colorStyles[color],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Component className={classes} id={id}>
      {children}
    </Component>
  );
}
