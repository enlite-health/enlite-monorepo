/**
 * TherapeuticProjectVersionView — UMA versão em leitura (modo `view` do drawer e o topo do card).
 * Texto clínico e CID chegam `null` com `redacted.clinical` quando falta `patient_clinical:read`
 * (lex C7): mostra o rótulo de redigido, nunca vazio. `data-clarity-mask` no texto clínico (C6).
 */
import { useTranslation } from 'react-i18next';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import type { DiagnosisPlanSnapshot, ObjectivesLayoutName, TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
import { Text } from '@presentation/components/atoms/Text';
import { formatIsoDateEsAr } from './pdf/therapeuticProjectPdfInput';
import { sortAlphabeticallyEs } from './alphabeticalOrder';

interface Props {
  version: TherapeuticProjectVersion;
  services: PatientContractedServiceDetail[];
  /** Compacto = o resumo do card (Figma `6390:13229`); completo = o drawer. */
  compact?: boolean;
  /** O ator não tem `patient_services:read`: `services` chega `[]` por REDAÇÃO, não por ausência (D113). */
  servicesRedacted?: boolean;
}

function Row({ label, children, testId, mask = false }: { label: string; children: React.ReactNode; testId?: string; mask?: boolean }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId} {...(mask ? { 'data-clarity-mask': 'True' } : {})}>
      <Text as="span" size="sm" weight="medium" color="secondary">{label}</Text>
      <div>{children}</div>
    </div>
  );
}

/** Spec 061: item com título e, se houver, a descrição congelada na versão (segundo parágrafo, mais discreto). */
function ListValue({ items, testPrefix }: { items: { id: string; label: string; description?: string | null }[]; testPrefix: string }): JSX.Element {
  if (items.length === 0) return <Text as="span" size="sm" color="muted">—</Text>;
  return (
    <ul className="list-disc pl-5">
      {items.map((i) => (
        <li key={i.id}>
          <Text as="span" size="sm" color="primary">{i.label}</Text>
          {i.description && (
            <Text size="xs" color="tertiary" className="mt-0.5 whitespace-pre-line" data-testid={`${testPrefix}-description-${i.id}`}>{i.description}</Text>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Os contatos RESOLVIDOS pela célula de origem (lex #7 C5) — nunca lê nome/telefone da versão
 * bruta. `inactive`/`redacted` são as duas formas sem dado — a tela mostra o rótulo, nunca vazio.
 */
function ContactsValue({ contacts, tc }: { contacts: TherapeuticProjectVersion['contacts']; tc: (k: string, o?: Record<string, unknown>) => string }): JSX.Element {
  if (contacts.length === 0) return <Text as="span" size="sm" color="muted">—</Text>;
  return (
    <ul className="list-disc pl-5" data-clarity-mask="True">
      {contacts.map((c) => (
        <li key={`${c.kind}-${c.id}`}>
          <Text as="span" size="sm" color="primary">
            {'inactive' in c ? tc('contactInactive') : 'redacted' in c ? tc('redacted') : c.name}
          </Text>
        </li>
      ))}
    </ul>
  );
}

const STATUS_FIELD_KEY: Record<string, string> = {
  RESPONSIBLE: 'responsibles',
  EXTERNAL: 'externalContacts',
  COVERAGE: 'coverageContacts',
  CARE_TEAM: 'careTeam',
};

/**
 * spec 048: o estado explícito de cada campo de contato — "Todavía no hay registro — vence el DD/MM" ou "No necesita" —
 * aparece NO LUGAR da lista vazia daquele campo (o estado e os contatos nunca coexistem no mesmo campo).
 */
function ContactStatusValue({ entries, tf }: { entries: TherapeuticProjectVersion['contactStatus']; tf: (k: string, o?: Record<string, unknown>) => string }): JSX.Element {
  return (
    <ul className="list-disc pl-5" data-testid="tpv-contact-status">
      {entries.map((e) => (
        <li key={e.kind} data-testid={`tpv-contact-status-${e.kind}`}>
          <Text as="span" size="sm" color="primary">
            {tf(STATUS_FIELD_KEY[e.kind])}: {e.status === 'PENDING'
              ? `${tf('contactPending')}${e.deadlineDate ? ` — ${tf('contactDueOn', { date: (formatIsoDateEsAr(e.deadlineDate) ?? e.deadlineDate).slice(0, 5) })}` : ''}`
              : tf('contactNotNeeded')}
          </Text>
        </li>
      ))}
    </ul>
  );
}

type Translate = (k: string, o?: Record<string, unknown>) => string;

/** O que cada formato precisa para desenhar objetivos, atividades e o Segmento. */
interface LayoutCtx {
  v: TherapeuticProjectVersion;
  compact: boolean;
  redacted: boolean;
  tc: Translate;
  tf: Translate;
  t: Translate;
}

/**
 * Strategy por formato da versão (DD-21: escolhida SÓ por `objectivesLayout`, nunca por `diagnosisPlans === null`).
 * `FlatLayoutView` = lista plana de sempre; `ByDiagnosisLayoutView` = grupos por diagnóstico, como o PDF (§9.9).
 */
interface LayoutView {
  segmentRow(ctx: LayoutCtx): JSX.Element | null;
  objectives(ctx: LayoutCtx): JSX.Element;
  activities(ctx: LayoutCtx): JSX.Element;
}

class FlatLayoutView implements LayoutView {
  segmentRow({ v, redacted, tc }: LayoutCtx): JSX.Element {
    // Spec 030: `redacted` (sem `patient_clinical:read`) ≠ `null` sem marcador (versão anterior à 496 → "—").
    return (
      <Row label={tc('segment')} testId="tpv-segment" mask>
        {redacted
          ? <Text as="span" size="sm" color="muted">{tc('redacted')}</Text>
          : <Text as="span" size="sm" color="primary">{v.segment?.label ?? '—'}</Text>}
      </Row>
    );
  }
  objectives({ v, compact }: LayoutCtx): JSX.Element {
    return <ListValue testPrefix="tpv-specific" items={compact ? v.specificObjectives.slice(0, 3) : v.specificObjectives} />;
  }
  activities({ v, compact }: LayoutCtx): JSX.Element {
    return <ListValue testPrefix="tpv-activities" items={compact ? sortAlphabeticallyEs(v.activities).slice(0, 3) : sortAlphabeticallyEs(v.activities)} />;
  }
}

type PlanItem = { id: string; label: string; description: string | null; suggestedFrequency?: string | null };

/** `título — descrição · Frecuencia: valor` (§9.9); o texto clínico do catálogo vai mascarado no Clarity (C6). */
function PlanGroups({ ctx, plans, testPrefix, pick }: { ctx: LayoutCtx; plans: DiagnosisPlanSnapshot[]; testPrefix: string; pick: (p: DiagnosisPlanSnapshot) => PlanItem[] }): JSX.Element {
  const { v, t } = ctx;
  // Chaves do formulário em cascata (T405) moram na RAIZ do i18n, não sob `admin.patients.detail`.
  const tp = (k: string, o?: Record<string, unknown>): string => t(`therapeuticProjectForm.${k}`, o);
  return (
    <div className="flex flex-col gap-3">
      {plans.map((plan) => {
        const title = v.diagnoses?.find((d) => d.uri === plan.diagnosisUri)?.title ?? plan.categoryCode ?? '—';
        return (
          <div key={plan.diagnosisUri} className="flex flex-col gap-1" data-testid={`${testPrefix}-group-${plan.diagnosisUri}`}>
            <Text as="span" size="sm" weight="medium" color="secondary">{`${t('admin.patients.detail.diagnosisCard.title')}: ${title}`}</Text>
            {plan.objectives.length === 0
              // DD-22: o vazio carrega a data da versão (`createdAt`), nunca só "sin catálogo".
              ? <Text size="xs" color="muted" data-testid={`${testPrefix}-empty-${plan.diagnosisUri}`}>{tp('noCatalogAt', { date: formatIsoDateEsAr(v.createdAt) ?? '—' })}</Text>
              : (
                <ul className="list-disc pl-5" data-clarity-mask="True">
                  {pick(plan).map((i) => (
                    <li key={i.id} data-testid={`${testPrefix}-item-${i.id}`}>
                      <Text as="span" size="sm" color="primary">
                        {i.label}{i.description ? ` — ${i.description}` : ''}{i.suggestedFrequency ? ` · ${tp('frequency', { value: i.suggestedFrequency })}` : ''}
                      </Text>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * `byDiagnosis`: grupos por diagnóstico, sem o campo Segmento (§9.9). Redigido (`redacted.clinical`, sem `diagnosisPlans`)
 * e o resumo compacto do card mostram a lista plana DERIVADA (DD-8), que a projeção sempre devolve.
 */
class ByDiagnosisLayoutView implements LayoutView {
  private readonly derivedFlat = new FlatLayoutView();
  private plansOf({ v, redacted, compact }: LayoutCtx): DiagnosisPlanSnapshot[] | null {
    return redacted || compact ? null : v.diagnosisPlans;
  }
  segmentRow(): null {
    return null;
  }
  objectives(ctx: LayoutCtx): JSX.Element {
    const plans = this.plansOf(ctx);
    return plans ? <PlanGroups ctx={ctx} plans={plans} testPrefix="tpv-specific" pick={(p) => p.objectives} /> : this.derivedFlat.objectives(ctx);
  }
  activities(ctx: LayoutCtx): JSX.Element {
    const plans = this.plansOf(ctx);
    return plans ? <PlanGroups ctx={ctx} plans={plans} testPrefix="tpv-activities" pick={(p) => p.activities} /> : this.derivedFlat.activities(ctx);
  }
}

const LAYOUT_VIEWS: Record<ObjectivesLayoutName, LayoutView> = {
  flat: new FlatLayoutView(),
  byDiagnosis: new ByDiagnosisLayoutView(),
};

export function TherapeuticProjectVersionView({ version: v, services, compact = false, servicesRedacted = false }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.therapeuticProjectCard.${k}`, o ?? {});
  const tf = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.therapeuticProjectForm.${k}`, o ?? {});
  const statusEntries = v.contactStatus ?? [];
  const redacted = v.redacted?.clinical === true;
  const service = services.find((s) => s.id === v.contractedServiceId) ?? null;
  // `[]` por falta de célula NÃO é "serviço não encontrado" (D113: `[]` × "não posso ver").
  const serviceLabel = service
    ? t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode)
    : servicesRedacted ? tc('redacted') : tc('serviceUnknown');

  const layout = LAYOUT_VIEWS[v.objectivesLayout];
  const ctx: LayoutCtx = { v, compact, redacted, tc, tf, t: t as Translate };

  const clinical = (text: string | null, testId: string): JSX.Element =>
    redacted || text === null
      ? <Text as="span" size="sm" color="muted" data-testid={`${testId}-redacted`}>{tc('redacted')}</Text>
      : <Text as="p" size="sm" color="primary" className={`whitespace-pre-wrap ${compact ? 'line-clamp-3' : ''}`} data-clarity-mask="True" data-testid={testId}>{text}</Text>;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-4" data-testid="therapeutic-project-version-view" data-version={v.version}>
      <div className="flex flex-col gap-4">
        <Row label={tc('cid')} testId="tpv-cid">
          {redacted || v.diagnoses === null
            ? <Text as="span" size="sm" color="muted">{tc('redacted')}</Text>
            : <ListValue testPrefix="tpv-diagnoses" items={v.diagnoses.map((d) => ({ id: d.uri, label: d.title }))} />}
        </Row>
        {layout.segmentRow(ctx)}
        <Row label={tc('service')} testId="tpv-service"><Text as="span" size="sm" color="primary">{serviceLabel}</Text></Row>
        <Row label={tc('modality')} testId="tpv-modality">
          {/* Enum do backend: fallback para o valor cru (régua do CLAUDE.md), nunca a chave de i18n. */}
          <Text as="span" size="sm" color="primary">{v.modality ? t(`admin.patients.detail.therapeuticProjectCard.modalityOptions.${v.modality}`, v.modality) : '—'}</Text>
        </Row>
        <Row label={tc('currentClinicalContext')} testId="tpv-clinical">{clinical(v.clinicalContext, 'tpv-clinical-text')}</Row>
        <Row label={tc('generalObjective')} testId="tpv-objective">{clinical(v.generalObjective, 'tpv-objective-text')}</Row>
        <Row label={tc('specificObjectives')} testId="tpv-specific">{layout.objectives(ctx)}</Row>
      </div>
      <div className="flex flex-col gap-4">
        <Row label={tc('activitiesPlan')} testId="tpv-activities">{layout.activities(ctx)}</Row>
        {/* "Tipo de patología" não aparece na tela: é máscara derivada do CID-11 para o Ana Care (DEC-09) — sai só no PDF. */}
        {!compact && (
          <Row label={tc('contacts')} testId="tpv-contacts">
            {(v.contacts.length > 0 || statusEntries.length === 0) && <ContactsValue contacts={v.contacts} tc={tc} />}
            {statusEntries.length > 0 && <ContactStatusValue entries={statusEntries} tf={tf} />}
          </Row>
        )}
        <Row label={tc('deadlines')} testId="tpv-deadlines">
          <Text as="span" size="sm" color="primary">{formatIsoDateEsAr(v.startDate)} - {formatIsoDateEsAr(v.endDate)}</Text>
        </Row>
        {v.annulledAt !== null && (
          <Row label={tc('annulled')} testId="tpv-annulled">
            <Text as="span" size="sm" className="text-red-600">{formatIsoDateEsAr(v.annulledAt)}{v.annulReason ? ` · ${v.annulReason}` : ''}</Text>
          </Row>
        )}
      </div>
    </div>
  );
}
