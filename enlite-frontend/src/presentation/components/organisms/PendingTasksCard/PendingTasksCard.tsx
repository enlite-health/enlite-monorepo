import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { destinationFor, buildProfileUrl, TAB_ORDER, type TabId } from '@presentation/utils/incompleteFieldDestinations';
import { requiredDocTypesFor } from '@presentation/utils/workerDocumentPolicy';

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

/** Ordem de registro (DD2): `TAB_ORDER` sem 'documents' — general → address → availability. */
const REGISTRATION_TAB_ORDER: readonly TabId[] = TAB_ORDER.filter((tab) => tab !== 'documents');

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
 * `doc_*` — na ordem da POLÍTICA DE PARIDADE COM O PORTÃO
 * (`workerDocumentPolicy.requiredDocTypesFor`, NULL/'' tratado como AT,
 * igual ao SQL gate e ao `BlockedApplicationRepository.expandDocumentToken`
 * do backend — NÃO `workerDocumentRequirements.ts`, que diverge de
 * propósito pra outro consumidor). Botão de cada linha leva direto ao
 * destino (`incompleteFieldDestinations` — sem segundo mapa
 * token→destino).
 *
 * Achado do gate (BLOCKER 1, 11/09): N (título) e "X de Y" tinham UNIDADES
 * DIFERENTES — N contava `missingFields.length` (tokens crus; 2 campos na
 * mesma aba contavam 2, mas só geravam 1 linha) enquanto X/Y usavam um
 * total FIXO (3 + docs exigidos). Um cadastro novo mostrava "Te falta 18
 * pasos" com 5 botões na tela. Agora as duas contas usam a MESMA unidade —
 * a LINHA renderizada (`rows.length`) — e Y é derivado delas, não fixo.
 *
 * `worker_documents` cru (BLOCKER 1b — fallback da Fase 1 quando a
 * expansão por documento falha): vira UMA linha genérica "Documentos" e
 * NENHUM documento entra no recolhido — marcar `doc_*` como concluído sem
 * saber quais é a mesma classe de erro que este componente existe pra
 * consertar (a home mentindo sobre o que falta).
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

  /** Nome legível de um token doc_* (ex.: doc_resume_cv → "Currículum vitae"). */
  const docLabel = (token: string): string =>
    t(`publicVacancy.incompleteModal.fields.${token}`, { defaultValue: token });

  if (missingFields.length === 0) return null;

  const registrationTokens = missingFields.filter((token) => destinationFor(token).tab !== 'documents');
  const documentsTokens = missingFields.filter((token) => destinationFor(token).tab === 'documents');

  const pendingTabsSet = new Set<TabId>(registrationTokens.map((token) => destinationFor(token).tab));

  const registrationRows: TaskRow[] = REGISTRATION_TAB_ORDER.filter((tab) => pendingTabsSet.has(tab)).map(
    (tab) => ({
      key: tab,
      label: t(`profile.tabs.${tab}`),
      actionLabel: t('profile.pendingTasks.completeAction'),
      url: buildProfileUrl({ tab }),
    }),
  );

  // Documentos obrigatórios pela política de PARIDADE COM O PORTÃO — NULL/''
  // vira AT (4 docs), igual ao SQL gate. Ordem já é DNI → antecedentes → CV
  // → certificado AT (mesma ordem que o backend expande).
  const requiredDocTokens = requiredDocTypesFor(profession).map((docType) => `doc_${docType}`);

  // Token cru (ex.: `worker_documents`) na aba documents que NÃO é `doc_*`:
  // a expansão por documento da Fase 1 falhou/não rodou — não dá pra saber
  // QUAL documento falta, então uma linha genérica, e nenhum doc_* entra
  // no recolhido como concluído (não sabemos que está feito).
  const hasGenericDocToken = documentsTokens.some((token) => !token.startsWith('doc_'));

  const documentRows: TaskRow[] = hasGenericDocToken
    ? [
        {
          key: 'documents-generic',
          label: t('profile.tabs.documents'),
          actionLabel: t('profile.pendingTasks.uploadAction'),
          url: buildProfileUrl({ tab: 'documents' }),
        },
      ]
    : [
        // Exigidos pela política (paridade com o portão) que o servidor
        // também está pedindo, na ordem da política — depois, qualquer
        // token EXTRA que o servidor pediu e a política local não conhece
        // (achado do gate 11/09, caso E: CAREGIVER com doc_resume_cv
        // pendente). F1/DD1 — `missingFields` é a fonte única; um doc_*
        // que o servidor marcou como pendente NUNCA pode desaparecer da
        // lista só porque a política local do frontend não o exige para
        // esta profissão.
        ...requiredDocTokens.filter((token) => documentsTokens.includes(token)),
        ...documentsTokens.filter((token) => !requiredDocTokens.includes(token)),
      ].map((token) => ({
        key: token,
        label: docLabel(token),
        actionLabel: t('profile.pendingTasks.uploadAction'),
        url: buildProfileUrl(destinationFor(token)),
      }));

  const rows: TaskRow[] = [...registrationRows, ...documentRows];

  const completedRegistrationLabels = REGISTRATION_TAB_ORDER.filter((tab) => !pendingTabsSet.has(tab)).map(
    (tab) => t(`profile.tabs.${tab}`),
  );
  const completedDocLabels = hasGenericDocToken
    ? []
    : requiredDocTokens.filter((token) => !documentsTokens.includes(token)).map(docLabel);
  const completedLabels = [...completedRegistrationLabels, ...completedDocLabels];

  // N (título) e Y (denominador) usam a MESMA unidade — a linha renderizada
  // (rows.length) — pra nunca mais divergir do que a pessoa vê na tela.
  const pendingCount = rows.length;
  const completedCount = completedLabels.length;
  const total = pendingCount + completedCount;

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
            data-testid="pending-task-row"
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
