import { ReactNode } from 'react';

type TextSize = '2xs' | 'xs' | 'sm' | 'base' | 'lg' | 'xl';
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

/**
 * 🔒 `2xs` (11px) — o degrau que faltava embaixo, e por que é UM só.
 *
 * A maquete "Registro de Plantillas" declara TREZE tamanhos — 9; 9,5; 10; 10,5;
 * 11; 11,5; 12; 12,5; 13; 14; 16; 17; 22 —, vários a meio pixel de distância.
 * Isso não é uma escala: é o que sai de escrever CSS à mão. Reproduzi-la aqui
 * significaria mintar oito tokens no atom mais usado do painel e importar a
 * AUSÊNCIA de sistema junto com a fidelidade.
 *
 * O que entra é o degrau que o painel de fato não tinha: nada abaixo de 12px,
 * enquanto a maquete usa 11px em 38 lugares — o tamanho mais frequente dela.
 * Os valores de meio pixel (11,5 e 12,5) arredondam para o vizinho: meio pixel
 * de fonte não é decisão de design, é resíduo de autoria.
 *
 * Entrelinha 1,5 como o `xs`, que é o que a maquete usa nesses textos.
 */
const sizeStyles: Record<TextSize, string> = {
  '2xs': 'text-[11px] leading-[1.5]',
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
