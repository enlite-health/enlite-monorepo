/**
 * Peças comuns do painel de custos (UI-1: nenhuma quebra de linha em nome, selo, cabeçalho, data e valor).
 * `Linha` = `Text` do DS com `whitespace-nowrap` e `data-single-line="<tipo>"`; com `truncar`, vira bloco com `truncate`
 * e `title` com o texto inteiro (o pai precisa de `min-w-0`). Cor SEMPRE `primary`/`tertiary` (UI-4: o `secondary`
 * padrão do `Text` dá 4,74:1).
 */
import type { ReactNode } from 'react';
import { Text } from '@presentation/components/atoms/Text';

export type LinhaTipo = 'nome' | 'selo' | 'cabecalho' | 'data' | 'valor';

interface LinhaProps {
  tipo: LinhaTipo;
  children: ReactNode;
  truncar?: boolean;
  size?: '2xs' | 'xs' | 'sm' | 'base' | 'lg' | 'xl';
  weight?: 'normal' | 'medium' | 'semibold' | 'bold';
  color?: 'primary' | 'tertiary';
  className?: string;
  title?: string;
  'data-testid'?: string;
}

export function Linha({ tipo, children, truncar = false, size = 'sm', weight = 'normal', color = 'primary', className = '', title, ...rest }: LinhaProps): JSX.Element {
  const inteiro = title ?? (truncar && typeof children === 'string' ? children : undefined);
  return (
    <Text
      as="span"
      size={size}
      weight={weight}
      color={color}
      title={inteiro}
      data-single-line={tipo}
      className={`whitespace-nowrap ${truncar ? 'block min-w-0 truncate' : ''} ${className}`}
      {...rest}
    >
      {children}
    </Text>
  );
}

/** Moldura de cartão do painel (borda `gray-600`, sem hex). */
export const CARD = 'min-w-0 rounded-2xl border border-gray-600 bg-white p-4 shadow-small md:p-6';
