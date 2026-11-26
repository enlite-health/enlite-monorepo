import { useTranslation } from 'react-i18next';
import type { CicloDeVida } from '@domain/value-objects/vacancyLifecycle';

interface VacancyLifecycleBadgeProps {
  /** Ciclo de vida que o back calcula (`lifecycle`); `null`/ausente = a resposta não trouxe (mostra "—"). */
  lifecycle: CicloDeVida | null | undefined;
  className?: string;
}

/**
 * Cores com texto escuro sobre fundo claro (régua AAA, 7:1 — `primary` #180149 sobre cada fundo abaixo ≥ 11:1).
 * Record exaustivo: ciclo novo no tipo sem linha aqui = erro de compilação. Nenhum mapa de valores de banco.
 */
const BG_POR_CICLO: Readonly<Record<CicloDeVida, string>> = {
  rascunho: 'bg-purple-100',
  aberta: 'bg-blue-100',
  pausada: 'bg-wait',
  cerrada: 'bg-slate-200',
  baja: 'bg-slate-300',
};

export function VacancyLifecycleBadge({ lifecycle, className = '' }: VacancyLifecycleBadgeProps): JSX.Element {
  const { t } = useTranslation();
  const bg = lifecycle ? BG_POR_CICLO[lifecycle] : 'bg-slate-200';
  return (
    <span
      data-testid="vacancy-lifecycle-badge"
      data-lifecycle={lifecycle ?? ''}
      className={`inline-flex items-center justify-center font-poppins font-semibold text-xs px-6 py-1 rounded text-primary ${bg} ${className}`}
    >
      {lifecycle ? t(`admin.vacancyDetail.lifecycle.${lifecycle}`) : '—'}
    </span>
  );
}
