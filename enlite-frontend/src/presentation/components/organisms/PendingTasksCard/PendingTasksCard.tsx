import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { destinationFor, buildProfileUrl, type TabId } from '@presentation/utils/incompleteFieldDestinations';
import { getRequiredDocSlugs } from '@presentation/utils/workerDocumentRequirements';

interface PendingTasksCardProps {
  /**
   * `missingFields` do `GET /api/workers/me` — SEMPRE do servidor, nunca
   * recalculado aqui (F1/DD1). `[]` some com o card (chamador decide não
   * renderizar; este componente também se protege sozinho, ver abaixo).
   */
  missingFields: string[];
  profession?: string | null;
  className?: string;
}

/** Ordem fixa de registro (DD2): general → address → availability. */
const REGISTRATION_TAB_ORDER: readonly TabId[] = ['general', 'address', 'availability'];

/**
 * Ordem da política de documentos (F5): DNI → antecedentes → CV → certificado
 * AT. Espelha `BASE_COLUMNS`/`AT_EXTRA_COLUMNS` de
 * worker-functions/.../documentTokenExpansion.ts — NÃO a ordem de
 * `workerDocumentRequirements.getRequiredDocSlugs` (que lista resume_cv
 * primeiro para AT). A ordem de EXIBIÇÃO segue F5; a CONTAGEM de exigidos
 * (Y) segue a política do frontend, como pedido.
 */
const DOC_TOKEN_ORDER = [
  'doc_identity_document',
  'doc_criminal_record',
  'doc_resume_cv',
  'doc_at_certificate',
] as const;

interface TaskRow {
  key: string;
  label: string;
  actionLabel: string;
  url: string;
}

/**
 * Lista de tarefas da home (Fase 2, DD2/DD3) — substitui o
 * `ProfileCompletionCard`. Uma linha por pendência: registro AGRUPADO por
 * aba (general/address/availability), documento como linha própria por
 * `doc_*`. Botão de cada linha leva direto ao destino
 * (`incompleteFieldDestinations` — sem segundo mapa token→destino).
 *
 * `data-clarity-mask="True"` no contêiner das linhas: nomeia o que falta no
 * cadastro da pessoa (parecer do lex, condição C12 — mesma régua do
 * `IncompleteRegistrationModal`).
 */
export function PendingTasksCard({
  missingFields,
  profession,
  className = '',
}: PendingTasksCardProps): JSX.Element | null {
  const { t } = useTranslation();
  const navigate = useNavigate();

  if (missingFields.length === 0) return null;

  const pendingTabsSet = new Set<TabId>(
    missingFields
      .filter((token) => destinationFor(token).tab !== 'documents')
      .map((token) => destinationFor(token).tab),
  );

  const pendingDocTokens = DOC_TOKEN_ORDER.filter((token) => missingFields.includes(token));

  const registrationRows: TaskRow[] = REGISTRATION_TAB_ORDER.filter((tab) => pendingTabsSet.has(tab)).map(
    (tab) => ({
      key: tab,
      label: t(`profile.tabs.${tab}`),
      actionLabel: t('profile.pendingTasks.completeAction'),
      url: buildProfileUrl({ tab }),
    }),
  );

  const documentRows: TaskRow[] = pendingDocTokens.map((token) => ({
    key: token,
    label: t(`publicVacancy.incompleteModal.fields.${token}`, { defaultValue: token }),
    actionLabel: t('profile.pendingTasks.uploadAction'),
    url: buildProfileUrl(destinationFor(token)),
  }));

  const rows: TaskRow[] = [...registrationRows, ...documentRows];

  // Y (denominador "de brinde"): 3 passos de registro + docs obrigatórios da
  // profissão PELA POLÍTICA DO FRONTEND (workerDocumentRequirements.ts) —
  // fonte pedida explicitamente para este número cosmético. A pendência em
  // si (N, e QUAIS docs faltam) já é 100% do servidor (Fase 1) — só este
  // total "quantos existem" usa a política local.
  const requiredDocSlugSet = new Set(getRequiredDocSlugs(profession));
  const requiredDocTokens = DOC_TOKEN_ORDER.filter((token) =>
    requiredDocSlugSet.has(token.replace('doc_', '')),
  );
  const total = REGISTRATION_TAB_ORDER.length + requiredDocTokens.length;
  const pendingCount = missingFields.length;
  const completedCount = Math.max(0, total - pendingCount);

  const completedRegistrationLabels = REGISTRATION_TAB_ORDER.filter((tab) => !pendingTabsSet.has(tab)).map(
    (tab) => t(`profile.tabs.${tab}`),
  );
  const completedDocLabels = requiredDocTokens
    .filter((token) => !missingFields.includes(token))
    .map((token) => t(`publicVacancy.incompleteModal.fields.${token}`, { defaultValue: token }));
  const completedLabels = [...completedRegistrationLabels, ...completedDocLabels];

  return (
    <div
      data-testid="pending-tasks-card"
      className={`w-full bg-white border-2 border-purple-100 rounded-2xl p-4 sm:p-6 shadow-sm ${className}`}
    >
      <Heading level={2} color="primary" className="text-base sm:text-xl mb-1" as="h2">
        {t('profile.pendingTasks.title', { count: pendingCount })}
      </Heading>
      <Text size="sm" color="muted" className="mb-4" data-testid="pending-tasks-progress">
        {t('profile.pendingTasks.completedOf', { done: completedCount, total })}
      </Text>

      <div className="flex flex-col gap-3" data-testid="pending-tasks-rows" data-clarity-mask="True">
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"
          >
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
            <Text as="span" size="sm" weight="medium" color="inherit" className="text-amber-900 flex-1">
              {row.label}
            </Text>
            <Button
              type="button"
              variant="primary"
              size="sm"
              aria-label={`${row.actionLabel} — ${row.label}`}
              onClick={() => navigate(row.url)}
            >
              {row.actionLabel}
            </Button>
          </div>
        ))}

        {completedLabels.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-1" data-testid="pending-tasks-completed">
            <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
            <Text as="span" size="sm" color="muted">
              {completedLabels.join(' · ')}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
