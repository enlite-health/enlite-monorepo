/**
 * VacancySemaphoreDot — o círculo do semáforo da vaga (change semaforo-da-vaga, F3).
 *
 * Só PINTA a cor que o servidor mandou; não compara `n` com nada (a política 5/10 mora no back, design.md §2). `n = 0` com
 * `color: 'green'` pinta verde.
 *
 * Cores = tokens Tailwind do tema, sem hex cru: red-600 (#DC2626, 4,83:1), amber-600 (#D97706, 3,19:1), green-600 (#16A34A,
 * 3,30:1, o mesmo do PresenceDot) contra o branco — passam o contraste não-textual de 3:1 (WCAG 1.4.11). O número ao lado fica
 * em `text-primary` (18,43:1, AAA). A cor não é a única informação: `aria-label` e `title` trazem a PALAVRA da cor.
 *
 * `value`: `{ color, n }` (lista de vagas, subcard) | `{ color }` (pior cor do paciente, sem n) | `null` ("—").
 */
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { SemaphoreColor } from '@domain/value-objects/vacancySemaphore';

export interface VacancySemaphoreDotProps {
  value: { color: SemaphoreColor; n?: number } | null;
  /** 'dotAndCount' (padrão, lista de vagas): círculo + n. 'dotOnly' (subcard estreito): só o círculo; o n segue no aria-label/title. */
  display?: 'dotAndCount' | 'dotOnly';
  testId?: string;
  className?: string;
}

const CIRCLE_CLASS: Record<SemaphoreColor, string> = {
  red: 'bg-red-600',
  yellow: 'bg-amber-600',
  green: 'bg-green-600',
};

export function VacancySemaphoreDot({ value, display = 'dotAndCount', testId = 'vacancy-semaphore-dot', className = '' }: VacancySemaphoreDotProps): JSX.Element {
  const { t } = useTranslation();

  if (!value) {
    const none = t('admin.semaphore.none');
    return (
      <Text as="span" color="primary" data-testid={testId} data-color="none" role="img" aria-label={none} title={none} className={className}>
        —
      </Text>
    );
  }

  const colorLabel = t(`admin.semaphore.colors.${value.color}`);
  const label = value.n === undefined ? colorLabel : t('admin.semaphore.dotAria', { color: colorLabel, n: value.n });
  return (
    <span
      data-testid={testId}
      data-color={value.color}
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex items-center gap-1.5 ${className}`}
    >
      <span data-part="circle" className={`inline-block h-3 w-3 shrink-0 rounded-full ${CIRCLE_CLASS[value.color]}`} />
      {display === 'dotAndCount' && value.n !== undefined && (
        <Text as="span" size="xs" weight="semibold" color="primary">
          {value.n}
        </Text>
      )}
    </span>
  );
}
