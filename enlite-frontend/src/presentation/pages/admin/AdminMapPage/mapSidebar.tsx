/**
 * mapSidebar — as duas peças de composição da coluna esquerda do /admin/mapa,
 * fora da página para ela caber nas 400 linhas.
 */
import type { ReactNode } from 'react';
import { Loader2, Undo2 } from 'lucide-react';
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

/**
 * Selo de "estou buscando" sobre a lista. Existe porque a lista é a maior massa
 * visual da tela e ficava IDÊNTICA durante a busca: o clique parecia não ter
 * feito nada. Medido em 01/09: o clique é registrado em 7ms e a viewport muda
 * aos 14ms — o problema nunca foi lentidão, foi ausência de aviso.
 */
export function Searching({ label }: { label: string }): JSX.Element {
  // `-top-3`: o selo encosta na BORDA da lista. Centrado por dentro ele cobria o
  // primeiro nome — feedback que esconde conteúdo troca um problema por outro.
  return (
    <div className="absolute inset-x-0 -top-3 flex justify-center pointer-events-none" data-testid="map-list-searching">
      <span className="inline-flex items-center gap-2 rounded-full bg-white border border-gray-200 shadow-sm px-3 py-1">
        <Loader2 size={13} className="animate-spin text-primary" />
        <Text as="span" size="xs" color="muted">{label}</Text>
      </span>
    </div>
  );
}

/** Legenda das bolinhas, uma entrada por cor. */
export function Legend({ label, entries }: { label: string; entries: Array<{ color: string; label: string }> }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1" data-testid="map-legend">
      <Text as="span" size="xs" color="muted">{label}</Text>
      {entries.map((e) => (
        <span key={e.color} className="inline-flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: e.color }} />
          <Text as="span" size="xs" color="muted">{e.label}</Text>
        </span>
      ))}
    </div>
  );
}

/** Escolher quem não tem coordenada não pode ser silêncio: o mapa não muda. */
export function NoLocationNotice({ text }: { text: string }): JSX.Element {
  return (
    <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2" data-testid="map-selected-no-location">
      <Text as="div" size="xs" color="secondary">{text}</Text>
    </div>
  );
}

/** Identidade legível do centro + o caminho de volta. */
export function CenterLabel({ text, backLabel, onBack }: { text: string; backLabel?: string; onBack?: () => void }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2" data-testid="map-center-label" data-clarity-mask="True">
      <Text as="div" size="xs" color="muted" className="truncate">{text}</Text>
      {backLabel && onBack && (
        <button type="button" onClick={onBack} data-testid="map-center-back" data-clarity-mask="True" className="inline-flex items-center gap-1 shrink-0 text-primary hover:underline">
          <Undo2 size={13} />
          <Text as="span" size="xs" color="inherit">{backLabel}</Text>
        </button>
      )}
    </div>
  );
}
