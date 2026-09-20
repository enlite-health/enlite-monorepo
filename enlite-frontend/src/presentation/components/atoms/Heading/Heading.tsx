import { HTMLAttributes, ReactNode } from 'react';

type HeadingLevel = 1 | 2 | 3 | 4;
/**
 * O tamanho VISUAL, independente do nível semântico.
 *
 * 🔒 `compact` são os números medidos do `.s-h1` da maquete de plantillas:
 * 22px, entrelinha 1,5, `letter-spacing: -0.01em`. Nenhum nível existente tem
 * 22px — `level={1}` é 24 e `level={2}` é 20 —, e sobrescrever por `className`
 * colidiria com a classe do nível (duas utilitárias de `font-size`, e quem
 * vence depende da ordem em que o Tailwind emite). Separar tamanho de nível é
 * também o certo em HTML: o `<h1>` continua sendo `<h1>`.
 */
type HeadingSize = HeadingLevel | 'compact';
type HeadingWeight = 'medium' | 'semibold' | 'bold';
type HeadingColor = 'primary' | 'secondary' | 'tertiary' | 'white' | 'inherit';

/**
 * Repassa os atributos de `<hN>` (`data-testid`, `aria-*`, `title`, `onClick`…) — molde do `Text`. Até
 * 08/09 um `<Heading data-testid="x">` era descartado em silêncio e o e2e não achava o título (LISTA da spec 017).
 */
interface HeadingProps extends Omit<HTMLAttributes<HTMLHeadingElement>, 'color' | 'className' | 'children' | 'id'> {
  level?: HeadingLevel;
  size?: HeadingSize;
  weight?: HeadingWeight;
  color?: HeadingColor;
  children: ReactNode;
  className?: string;
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  id?: string;
}

const levelStyles: Record<HeadingSize, string> = {
  1: 'text-2xl leading-tight',
  2: 'text-xl leading-tight',
  3: 'text-lg leading-snug',
  4: 'text-base leading-snug',
  compact: 'text-[22px] leading-[1.5] tracking-[-0.01em]',
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
  size,
  weight = 'semibold',
  color = 'primary',
  children,
  className = '',
  as,
  id,
  ...rest
}: HeadingProps): JSX.Element {
  const Component = (as || (`h${level}` as const)) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  const classes = [
    'font-poppins',
    levelStyles[size ?? level],
    weightStyles[weight],
    colorStyles[color],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Component className={classes} id={id} {...rest}>
      {children}
    </Component>
  );
}
