import { LabelHTMLAttributes, ReactNode } from 'react';

/**
 * O tamanho do rótulo.
 *
 * 🔒 `compact` (12px) existe porque o rótulo de 18px foi desenhado para
 * formulários de uma coluna, com muito respiro. Numa tela densa — o compositor
 * de plantillas, com quatro campos e uma coluna de pré-visualização ao lado —
 * ele compete com o próprio conteúdo do campo. `default` fica como está: nenhum
 * uso existente muda.
 *
 * Mesma escala do `inputSize="compact"` do `Input`, para os dois combinarem.
 */
export type LabelSize = 'default' | 'compact';

/**
 * 🔒 A COR ANDA JUNTO COM O TAMANHO, e não é capricho: o rótulo de `default` é
 * cinza (#737373) porque acompanha um campo grande e cinza; o `compact` do
 * desenho de plantillas é #180149, porque ali o rótulo é estrutura da tela, não
 * legenda. Separá-los faria a cor ficar num `className` por fora, colidindo com
 * a do base — duas utilitárias de `color`, e quem vence depende da ordem em que
 * o Tailwind emite.
 */
const SIZE_CLASSES: Record<LabelSize, string> = {
  default: 'text-[18px] leading-[1.3] text-[#737373]',
  compact: 'text-[12px] leading-[1.5] text-primary',
};

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  children: ReactNode;
  required?: boolean;
  optional?: boolean;
  size?: LabelSize;
}

export function Label({
  children,
  required = false,
  optional = false,
  size = 'default',
  className = '',
  ...props
}: LabelProps): JSX.Element {
  return (
    <label
      className={`font-['Lexend'] font-medium ${SIZE_CLASSES[size]} ${className}`}
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
