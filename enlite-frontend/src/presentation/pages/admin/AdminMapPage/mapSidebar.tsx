/**
 * mapSidebar — as duas peças de composição da coluna esquerda do /admin/mapa,
 * fora da página para ela caber nas 400 linhas.
 */
import type { ReactNode } from 'react';
import { Label } from '@presentation/components/atoms/Label';
import { Text } from '@presentation/components/atoms/Text';

/**
 * Rótulo visível + controle. O `!text-[13px]` encolhe o `Label` (18px por
 * padrão) só aqui: rótulo de filtro não é rótulo de formulário, e a 18px os
 * seis rótulos empurrariam a lista para fora da tela. `group` é para o
 * controle que NÃO é um elemento de formulário (o seletor com busca): ali o
 * nome acessível vem por `aria-labelledby`, porque `htmlFor` não teria alvo.
 */
export function Field({ id, label, group = false, children }: { id: string; label: string; group?: boolean; children: ReactNode }): JSX.Element {
  const labelId = `${id}-label`;
  return (
    <div className="flex flex-col gap-1 min-w-0" {...(group ? { role: 'group', 'aria-labelledby': labelId } : {})}>
      <Label id={labelId} {...(group ? {} : { htmlFor: id })} className="!text-[13px]">{label}</Label>
      {children}
    </div>
  );
}

/** Cabeçalho do passo — a tela é lida em 1 (centro) → 2 (filtros) → 3 (resultados). */
export function Step({ n, title }: { n: number; title: string }): JSX.Element {
  return (
    <Text as="div" size="xs" weight="semibold" color="tertiary" className="uppercase tracking-wide">
      {`${n} · ${title}`}
    </Text>
  );
}
