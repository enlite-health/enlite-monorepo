/**
 * Bloco por diagnóstico do PTI (091, §9.8, DF-6): título do diagnóstico, Paso 3 "Objetivos específicos"
 * (checkbox com título + descrição) e Paso 4 "Actividades" (só as dos objetivos marcados, agrupadas sob o
 * objetivo; título + descrição + frecuencia; desabilitado sem objetivo marcado).
 *
 * Duas peças: `TherapeuticProjectDiagnosisBlock` (editável, lê a regra da `TherapeuticCascade`) e
 * `TherapeuticProjectDiagnosisBlockReadOnly` (snapshot congelado, "Editar" de versão `byDiagnosis`: MACRO só leitura).
 * Padrão: Strategy por tabela `status -> corpo` (`BODY_BY_STATUS`), sem if/switch por status (DD-20).
 * `data-clarity-mask` nos textos do catálogo/diagnóstico (dado de saúde, lex C8).
 */
import { useTranslation } from 'react-i18next';
import type { TherapeuticCascade } from '@domain/entities/TherapeuticCascade';
import type {
  CascadeBlock,
  CascadeBlockStatus,
  DiagnosisPlanSnapshot,
} from '@domain/entities/TherapeuticProject';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { Text } from '@presentation/components/atoms/Text';

type Translate = (key: string, opts?: Record<string, unknown>) => string;

const useFormText = (): Translate => {
  const { t } = useTranslation();
  return (key, opts) => t(`therapeuticProjectForm.${key}`, opts ?? {});
};

const domId = (...parts: string[]): string => parts.join('-').replace(/[^A-Za-z0-9_-]/g, '_');

function ItemText({ label, description, frequency, tt }: { label: string; description: string | null; frequency?: string | null; tt: Translate }): JSX.Element {
  return (
    <span className="flex flex-col" data-clarity-mask="True">
      <Text as="span" size="sm" color="primary">{label}</Text>
      {description && <Text as="span" size="xs" color="muted">{description}</Text>}
      {frequency && <Text as="span" size="xs" color="muted" data-testid="tp-activity-frequency">{tt('frequency', { value: frequency })}</Text>}
    </span>
  );
}

function BlockTitle({ title, testId }: { title: string; testId: string }): JSX.Element {
  return <Text as="p" size="sm" color="primary" className="font-semibold" data-clarity-mask="True" data-testid={testId}>{title}</Text>;
}

// ── Editável ────────────────────────────────────────────────────────────────

interface BlockProps {
  /** Título do diagnóstico (o chip do passo 2). */
  title: string;
  block: CascadeBlock;
  cascade: TherapeuticCascade;
  /** `planIncomplete` visível (o operador já mexeu neste bloco e ele ainda reprova). */
  showIncomplete: boolean;
  disabled?: boolean;
  onToggleObjective: (objectiveId: string) => void;
  onToggleActivity: (activityId: string) => void;
}

function CatalogBody({ block, cascade, disabled, onToggleObjective, onToggleActivity, tt }: BlockProps & { tt: Translate }): JSX.Element {
  const uri = block.diagnosisUri;
  const canPick = cascade.canPickActivities(uri);
  return (
    <>
      <fieldset className="flex flex-col gap-2" data-testid={`tp-objectives-${uri}`}>
        <legend className="text-xs font-medium text-gray-800 mb-1">{tt('stepObjectives')}</legend>
        {block.objectives.map((o) => (
          <Checkbox
            key={o.id}
            id={domId('tp-obj', uri, o.id)}
            data-testid={`tp-obj-${uri}-${o.id}`}
            checked={cascade.isObjectiveSelected(uri, o.id)}
            disabled={disabled}
            onChange={() => onToggleObjective(o.id)}
            labelContent={<ItemText label={o.label} description={o.description} tt={tt} />}
          />
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-3" disabled={!canPick} data-testid={`tp-activities-${uri}`}>
        <legend className="text-xs font-medium text-gray-800 mb-1">{tt('stepActivities')}</legend>
        {!canPick && <Text size="xs" color="muted" data-testid={`tp-pick-objective-${uri}`}>{tt('pickObjectiveFirst')}</Text>}
        {cascade.selectedObjectives(uri).map((o) => (
          <div key={o.id} className="flex flex-col gap-2" data-testid={`tp-activity-group-${uri}-${o.id}`}>
            <Text as="span" size="xs" color="muted" className="font-medium" data-clarity-mask="True">{o.label}</Text>
            {o.activities.map((a) => (
              <Checkbox
                key={a.id}
                id={domId('tp-act', uri, o.id, a.id)}
                data-testid={`tp-act-${uri}-${o.id}-${a.id}`}
                checked={cascade.isActivitySelected(uri, a.id)}
                disabled={disabled || !canPick}
                onChange={() => onToggleActivity(a.id)}
                labelContent={<ItemText label={a.label} description={a.description} frequency={a.suggestedFrequency} tt={tt} />}
              />
            ))}
          </div>
        ))}
      </fieldset>
    </>
  );
}

function NoCatalogBody({ block, tt }: BlockProps & { tt: Translate }): JSX.Element {
  return <Text size="sm" className="text-amber-700" data-testid={`tp-no-catalog-${block.diagnosisUri}`}>{tt('noCatalog')}</Text>;
}

/** Strategy por tabela: o status do back (dono de "tem catálogo", DD-20) escolhe o corpo; sem catálogo, aviso e nenhuma escolha. */
const BODY_BY_STATUS: Readonly<Record<CascadeBlockStatus, (p: BlockProps & { tt: Translate }) => JSX.Element>> = {
  ok: CatalogBody,
  no_category: NoCatalogBody,
  no_catalog: NoCatalogBody,
};

export function TherapeuticProjectDiagnosisBlock(props: BlockProps): JSX.Element {
  const tt = useFormText();
  const Body = BODY_BY_STATUS[props.block.status];
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-gray-600 p-4" data-testid={`tp-block-${props.block.diagnosisUri}`} data-status={props.block.status}>
      <BlockTitle title={props.title} testId={`tp-block-title-${props.block.diagnosisUri}`} />
      <Body {...props} tt={tt} />
      {props.showIncomplete && (
        <Text size="xs" className="text-red-600" role="alert" data-testid={`tp-plan-incomplete-${props.block.diagnosisUri}`}>{tt('planIncomplete')}</Text>
      )}
    </section>
  );
}

// ── Só leitura (snapshot da versão `byDiagnosis`) ───────────────────────────

interface ReadOnlyProps {
  title: string;
  plan: DiagnosisPlanSnapshot;
}

export function TherapeuticProjectDiagnosisBlockReadOnly({ title, plan }: ReadOnlyProps): JSX.Element {
  const tt = useFormText();
  const uri = plan.diagnosisUri;
  const list = (items: ReadonlyArray<{ id: string; label: string; description: string | null; suggestedFrequency?: string | null }>, kind: 'objectives' | 'activities') =>
    items.length === 0
      ? <Text as="span" size="sm" color="muted" data-testid={`tp-${kind}-locked-${uri}`}>—</Text>
      : (
        <ul className="list-disc pl-5" data-testid={`tp-${kind}-locked-${uri}`}>
          {items.map((i) => (
            <li key={i.id}>
              <ItemText
                label={i.label}
                description={i.description}
                frequency={i.suggestedFrequency}
                tt={tt}
              />
            </li>
          ))}
        </ul>
      );
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-gray-600 p-4" data-testid={`tp-block-${uri}`}>
      <BlockTitle title={title} testId={`tp-block-title-${uri}`} />
      <Text as="span" size="xs" color="muted" className="font-medium">{tt('stepObjectives')}</Text>
      {list(plan.objectives, 'objectives')}
      <Text as="span" size="xs" color="muted" className="font-medium">{tt('stepActivities')}</Text>
      {list(plan.activities, 'activities')}
    </section>
  );
}
