import type { ComponentProps } from 'react';
import { Text } from '@presentation/components/atoms/Text';

type SingleLineProps = Omit<ComponentProps<typeof Text>, 'children' | 'title' | 'as'> & {
  /** O texto inteiro: é o conteúdo E o `title` (acessível quando a reticência corta). */
  children: string;
  as?: 'span' | 'div' | 'p';
};

/**
 * Nome de pessoa e texto secundário (motivo, papel, "salvo vie 30: nadie", endereço…): UMA linha, SEMPRE (regra do Gabriel, spec 069:
 * "nenhum nome/label quebra linha"). `truncate` (overflow oculto + reticência + nowrap) com `min-w-0` para encolher dentro de flex/grid, e
 * o `title` com o texto inteiro. O `data-single-line` marca o elemento para o guarda e2e de linha única (`patient-itinerary-linha-unica-069`).
 * Rótulos de AÇÃO/estado ("Deshacer", "Elegir quién entra", chips) NÃO usam isto: não se trunca ação — usam `whitespace-nowrap` e a coluna cresce.
 */
export function SingleLine({ children, className = '', as = 'span', ...rest }: SingleLineProps): JSX.Element {
  return (
    <Text as={as} {...rest} title={children} data-single-line="" className={`block min-w-0 max-w-full truncate ${className}`}>
      {children}
    </Text>
  );
}

/** Atributo-guarda para rótulos de ação/estado que não truncam (`whitespace-nowrap`): o e2e confere que seguem em UMA linha. */
export const NOWRAP = { 'data-single-line': '' } as const;
