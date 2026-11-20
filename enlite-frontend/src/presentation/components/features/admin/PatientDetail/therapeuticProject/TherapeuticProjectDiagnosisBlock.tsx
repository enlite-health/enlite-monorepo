/**
 * Bloco por diagnóstico do PTI (091, §9.8, DF-6; 099 direção A "Objetivo como tarjeta"): acordeão com título,
 * contador e pílula de estado; cada objetivo é um cartão-botão e as atividades dele aparecem DENTRO do cartão
 * marcado (título + descrição + frecuencia), empilhadas.
 *
 * Duas peças: `TherapeuticProjectDiagnosisBlock` (editável, lê a regra da `TherapeuticCascade`) e
 * `TherapeuticProjectDiagnosisBlockReadOnly` (snapshot congelado, "Editar" de versão `byDiagnosis`: MACRO só leitura).
 * Padrão: Strategy por tabela `status -> corpo` (`BODY_BY_STATUS`), sem if/switch por status (DD-20).
 * `data-clarity-mask` nos textos do catálogo/diagnóstico (dado de saúde, lex C8).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, ChevronDown, ChevronRight, Plus, type LucideIcon } from 'lucide-react';
import type { TherapeuticCascade } from '@domain/entities/TherapeuticCascade';
import type {
  CascadeActivity,
  CascadeBlock,
  CascadeBlockStatus,
  CascadeObjective,
  DiagnosisPlanSnapshot,
} from '@domain/entities/TherapeuticProject';
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

// ── Editável (099, direção A: "Objetivo como tarjeta") ───────────────────────

interface BlockProps {
  /** Título do diagnóstico (o chip do passo 2). */
  title: string;
  block: CascadeBlock;
  cascade: TherapeuticCascade;
  /** `planIncomplete` visível (o operador já mexeu neste bloco e ele ainda reprova). */
  showIncomplete: boolean;
  disabled?: boolean;
  /** O acordeão nasce aberto? (o formulário abre só o 1º diagnóstico). */
  defaultOpen?: boolean;
  /** Frase da recusa do servidor para ESTE bloco (422 `ptp_plan_*`, DD-21). */
  refusal?: string;
  onToggleObjective: (objectiveId: string) => void;
  onToggleActivity: (activityId: string) => void;
}

type PillState = 'ok' | 'warn' | 'empty' | 'nocat';
type Pick = 'on' | 'off';
const pickOf = (selected: boolean): Pick => (selected ? 'on' : 'off');

// Tokens do desenho 099 (valores exatos). `primary` (#180149) já é token do tailwind.config.js.
const FOCUS = 'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#2B51D6]';

/** Strategy por tabela: estado do bloco -> pílula (cores, ícone, chave de texto). Sem if por estado. */
const PILL_BY_STATE: Readonly<Record<PillState, { className: string; labelKey: string; Icon: LucideIcon | null }>> = {
  ok: { className: 'bg-[#EAF5EE] text-[#145A32]', labelKey: 'pillComplete', Icon: Check },
  warn: { className: 'bg-[#FDF0EF] text-[#9A1B12]', labelKey: 'pillMissingActivity', Icon: AlertCircle },
  empty: { className: 'bg-[#F3F2F6] text-[#4A4458]', labelKey: 'pillNoneChosen', Icon: null },
  nocat: { className: 'bg-[#FFF4E0] text-[#7A3300]', labelKey: 'pillNoCatalog', Icon: null },
};

/** Strategy por tabela: marcado/desmarcado -> estilo do cartão do objetivo, da caixinha, da atividade e do subtítulo. */
const OBJECTIVE_CARD: Readonly<Record<Pick, string>> = {
  on: 'border border-primary shadow-[0_0_0_1px_#180149] bg-[#FBFAFE]',
  off: 'border border-gray-600 bg-white',
};
const OBJECTIVE_BOX: Readonly<Record<Pick, string>> = {
  on: 'bg-primary border-primary',
  off: 'bg-white border-[#7A748A]',
};
const ACTIVITY_TILE: Readonly<Record<Pick, string>> = {
  on: 'bg-primary border-primary text-white',
  off: 'bg-white border-[#7A748A] text-primary',
};
const ACTIVITY_SUB: Readonly<Record<Pick, string>> = { on: 'text-[#C9C2DD]', off: 'text-[#4A4458]' };

interface Progress {
  complete: boolean;
  objectives: number;
}

/** Strategy por tabela: o status do back (dono de "tem catálogo", DD-20) escolhe o estado da pílula. */
const PILL_STATE_BY_STATUS: Readonly<Record<CascadeBlockStatus, (p: Progress) => PillState>> = {
  ok: ({ complete, objectives }) => (complete ? 'ok' : objectives > 0 ? 'warn' : 'empty'),
  no_category: () => 'nocat',
  no_catalog: () => 'nocat',
};

interface BodyProps extends BlockProps {
  tt: Translate;
}

function ActivityTile({ uri, objectiveId, activity, selected, disabled, onToggle, tt }: {
  uri: string; objectiveId: string; activity: CascadeActivity; selected: boolean; disabled?: boolean; onToggle: () => void; tt: Translate;
}): JSX.Element {
  const pick = pickOf(selected);
  const Icon = selected ? Check : Plus;
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onToggle}
      data-testid={`tp-act-${uri}-${objectiveId}-${activity.id}`}
      className={`min-h-[44px] box-border px-3 py-2.5 rounded-[10px] border-[1.5px] flex items-start gap-2.5 text-left cursor-pointer ${FOCUS} ${ACTIVITY_TILE[pick]}`}
    >
      <span className="flex mt-0.5 shrink-0"><Icon size={16} strokeWidth={2.5} aria-hidden="true" /></span>
      <span className="flex flex-col gap-0.5 min-w-0" data-clarity-mask="True">
        <span className="text-[13px] leading-[1.4] font-semibold">{activity.label}</span>
        {activity.description && <span className={`text-xs leading-[1.45] ${ACTIVITY_SUB[pick]}`}>{activity.description}</span>}
        {activity.suggestedFrequency && (
          <span className={`text-xs leading-[1.45] font-medium ${ACTIVITY_SUB[pick]}`} data-testid="tp-activity-frequency">{tt('frequency', { value: activity.suggestedFrequency })}</span>
        )}
      </span>
    </button>
  );
}

function ObjectiveCard({ uri, objective, selected, picked, disabled, cascade, onToggleObjective, onToggleActivity, tt }: {
  uri: string; objective: CascadeObjective; selected: boolean; picked: number; disabled?: boolean; cascade: TherapeuticCascade;
  onToggleObjective: () => void; onToggleActivity: (id: string) => void; tt: Translate;
}): JSX.Element {
  const pick = pickOf(selected);
  const total = objective.activities.length;
  const sideText = selected ? tt('activitiesPicked', { picked, total }) : tt('activitiesCount', { count: total });
  return (
    <div className={`rounded-xl ${OBJECTIVE_CARD[pick]}`}>
      <button
        type="button"
        aria-pressed={selected}
        disabled={disabled}
        onClick={onToggleObjective}
        data-testid={`tp-obj-${uri}-${objective.id}`}
        className={`w-full min-h-[64px] box-border px-4 py-3.5 rounded-xl flex items-start gap-3.5 text-left cursor-pointer ${FOCUS}`}
      >
        <span className={`w-[22px] h-[22px] box-border mt-px rounded-md border-2 shrink-0 flex items-center justify-center ${OBJECTIVE_BOX[pick]}`}>
          {selected && <Check size={12} strokeWidth={3} className="text-white" aria-hidden="true" />}
        </span>
        <span className="flex-1 min-w-0 flex flex-col gap-0.5" data-clarity-mask="True">
          <span className="text-[15px] leading-[1.4] font-semibold text-primary">{objective.label}</span>
          {objective.description && <span className="text-[13px] leading-[1.45] text-[#4A4458]">{objective.description}</span>}
        </span>
        <span className="shrink-0 text-xs leading-[1.4] font-medium text-[#4A4458] pt-0.5">{sideText}</span>
      </button>
      {selected && (
        <div className="pt-0 pr-4 pb-4 pl-[52px] flex flex-col gap-2" data-testid={`tp-activity-group-${uri}-${objective.id}`}>
          <span className="text-xs leading-[1.4] font-semibold text-[#4A4458]">{tt('activitiesOfObjective')}</span>
          <div className="flex flex-col gap-2">
            {objective.activities.map((a) => (
              <ActivityTile
                key={a.id}
                uri={uri}
                objectiveId={objective.id}
                activity={a}
                selected={cascade.isActivitySelected(uri, a.id)}
                disabled={disabled}
                onToggle={() => onToggleActivity(a.id)}
                tt={tt}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CatalogBody({ block, cascade, disabled, onToggleObjective, onToggleActivity, tt }: BodyProps): JSX.Element {
  const uri = block.diagnosisUri;
  return (
    <div className="flex flex-col gap-2.5" data-testid={`tp-objectives-${uri}`}>
      {block.objectives.map((o) => (
        <ObjectiveCard
          key={o.id}
          uri={uri}
          objective={o}
          selected={cascade.isObjectiveSelected(uri, o.id)}
          picked={o.activities.filter((a) => cascade.isActivitySelected(uri, a.id)).length}
          disabled={disabled}
          cascade={cascade}
          onToggleObjective={() => onToggleObjective(o.id)}
          onToggleActivity={onToggleActivity}
          tt={tt}
        />
      ))}
    </div>
  );
}

function NoCatalogBody({ block, tt }: BodyProps): JSX.Element {
  return <p className="m-0 px-3.5 py-3 rounded-[10px] bg-[#FFF4E0] text-sm leading-normal text-[#7A3300]" data-testid={`tp-no-catalog-${block.diagnosisUri}`}>{tt('noCatalog')}</p>;
}

/** Strategy por tabela: o status do back (dono de "tem catálogo", DD-20) escolhe o corpo; sem catálogo, aviso e nenhuma escolha. */
const BODY_BY_STATUS: Readonly<Record<CascadeBlockStatus, (p: BodyProps) => JSX.Element>> = {
  ok: CatalogBody,
  no_category: NoCatalogBody,
  no_catalog: NoCatalogBody,
};

/** Contador do cabeçalho: com catálogo "N objetivo(s) · N actividad(es)"; sem catálogo, "Sin objetivos para elegir". */
const COUNTER_BY_STATUS: Readonly<Record<CascadeBlockStatus, (n: { objectives: number; activities: number }, tt: Translate) => string>> = {
  ok: (n, tt) => `${tt('objectivesCount', { count: n.objectives })} · ${tt('activitiesCount', { count: n.activities })}`,
  no_category: (_n, tt) => tt('noObjectivesToPick'),
  no_catalog: (_n, tt) => tt('noObjectivesToPick'),
};

export function TherapeuticProjectDiagnosisBlock(props: BlockProps): JSX.Element {
  const tt = useFormText();
  const { block, cascade } = props;
  const uri = block.diagnosisUri;
  const [open, setOpen] = useState(props.defaultOpen === true);
  // A recusa do servidor (422) é deste bloco: abre o acordeão para ela não ficar escondida.
  useEffect(() => { if (props.refusal) setOpen(true); }, [props.refusal]);
  const Body = BODY_BY_STATUS[block.status];
  const objectives = cascade.selectedObjectives(uri).length;
  const activities = cascade.activitiesOf(uri).filter((a) => cascade.isActivitySelected(uri, a.id)).length;
  const pill = PILL_BY_STATE[PILL_STATE_BY_STATUS[block.status]({ complete: cascade.isBlockComplete(uri), objectives })];
  const panelId = domId('tp-panel', uri);
  return (
    <section className="rounded-xl border border-gray-600 bg-white" data-testid={`tp-block-${uri}`} data-status={block.status}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        data-testid={`tp-block-toggle-${uri}`}
        className={`w-full min-h-[64px] box-border px-5 py-3.5 rounded-xl flex items-center gap-3 text-left cursor-pointer ${FOCUS}`}
      >
        <span className="flex text-primary shrink-0">{open ? <ChevronDown size={20} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={20} strokeWidth={2} aria-hidden="true" />}</span>
        <span className="flex-1 min-w-0 flex flex-col gap-0.5" data-clarity-mask="True">
          <span className="font-poppins text-base leading-[1.35] font-semibold text-primary" data-testid={`tp-block-title-${uri}`}>{props.title}</span>
          <span className="text-[13px] leading-[1.4] text-[#4A4458]" data-testid={`tp-block-counter-${uri}`}>{COUNTER_BY_STATUS[block.status]({ objectives, activities }, tt)}</span>
        </span>
        <span className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs leading-[1.4] font-semibold ${pill.className}`} data-testid={`tp-block-pill-${uri}`}>
          {pill.Icon && <pill.Icon size={14} strokeWidth={2.5} aria-hidden="true" />}
          {tt(pill.labelKey)}
        </span>
      </button>
      {open && (
        <div id={panelId} className="px-5 pb-5 flex flex-col gap-2.5">
          <Body {...props} tt={tt} />
          {props.showIncomplete && (
            <p className="m-0 flex items-center gap-2 text-[13px] leading-[1.45] font-medium text-[#9A1B12]" role="alert" data-testid={`tp-plan-incomplete-${uri}`}>
              <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
              {tt('planIncomplete')}
            </p>
          )}
          {props.refusal && (
            <p className="m-0 flex items-center gap-2 text-[13px] leading-[1.45] font-medium text-[#9A1B12]" role="alert" data-testid={`tp-block-refusal-${uri}`}>
              <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
              {props.refusal}
            </p>
          )}
        </div>
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
