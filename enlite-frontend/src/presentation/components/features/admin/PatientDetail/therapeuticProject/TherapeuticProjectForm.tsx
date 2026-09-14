/**
 * TherapeuticProjectForm — o formulário de UMA versão do projeto terapêutico (spec 017, Figma
 * `6017:14962`): serviço contratado (o operador escolhe — Gabriel 4a), CID-11 (só CID, combobox
 * existente, REQ-21: código invisível), síntese clínica, objetivo geral (texto livre — Obs3), os 3
 * multi-selects do catálogo, prazo. Sem `major`/`minor`: a numeração é do servidor.
 *
 * PR-7 (task 7.7, D328/ADR-4): editando a VIGENTE (`from !== null`), os campos MACRO de
 * `fieldClass.macro` (dono único: `THERAPEUTIC_FIELD_CLASS` no backend) renderizam como TEXTO, nunca
 * como input desabilitado — a lista de QUAIS campos é MACRO vem da API, não é copiada aqui.
 * Contatos/equipe (MICRO) são sempre editáveis, escolhidos das listas já filtradas por ATIVO que a
 * ficha do paciente carrega (D286: nada aqui refaz esse filtro).
 *
 * Rótulo "ICHOM" não existe (D299.2). `data-clarity-mask` nos textos clínicos (lex C6).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type {
  PatientContractedServiceDetail,
  PatientCoverageEmergencyContact,
  PatientDiagnosisDetail,
  PatientExternalContactDetail,
  PatientProfessionalDetail,
  PatientResponsibleDetail,
} from '@domain/entities/PatientDetail';
import {
  THERAPEUTIC_MODALITIES,
  THERAPEUTIC_TEXT_MAX,
  type ContactRef,
  type ContactRefKind,
  type ResolvedTherapeuticContactKind,
  type TherapeuticDiagnosis,
  type TherapeuticFieldClass,
  type TherapeuticModality,
  type TherapeuticProjectVersion,
  type TherapeuticProjectVersionBody,
} from '@domain/entities/TherapeuticProject';
import type { TherapeuticCatalogs } from '@hooks/admin/useTherapeuticProjects';
import { FormField } from '@presentation/components/molecules/FormField';
import { Select } from '@presentation/components/atoms/Select';
import { MultiSelect } from '@presentation/components/atoms/MultiSelect';
import { Input } from '@presentation/components/atoms/Input';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { ClinicalTextareaField } from '../edit/ClinicalTextareaField';
import { IcdSearchCombobox } from '../edit/IcdSearchCombobox';

interface Props {
  services: PatientContractedServiceDetail[];
  /** Diagnósticos do cadastro — pré-preenchem o CID numa versão NOVA. */
  patientDiagnoses: PatientDiagnosisDetail[];
  catalogs: TherapeuticCatalogs;
  /** Lista MACRO×MICRO da API (task 7.7) — dono único é o backend; aqui só se lê. */
  fieldClass: TherapeuticFieldClass;
  /** As 4 listas de onde se escolhe contato/equipe — já chegam ATIVAS-apenas (D286, servidor filtra). */
  responsibles: PatientResponsibleDetail[];
  externalContacts: PatientExternalContactDetail[];
  coverageEmergencyContacts: PatientCoverageEmergencyContact[];
  professionals: PatientProfessionalDetail[];
  /** Versão de origem ("Editar") — os campos nascem dela. `null` = "Novo". */
  from: TherapeuticProjectVersion | null;
  saving: boolean;
  saveError: string | null;
  onSubmit: (body: TherapeuticProjectVersionBody) => void;
  onCancel: () => void;
  onDirty: () => void;
}

const today = (): string => new Date().toISOString().slice(0, 10);

const idsOfKind = (refs: ContactRef[] | undefined, kind: ContactRefKind): string[] =>
  (refs ?? []).filter((r) => r.kind === kind).map((r) => r.id);

/**
 * Conserto 14/09 (achado do gate — decisão do Gabriel, fechada): ao EDITAR, um contato da versão
 * de ORIGEM que já está INATIVO não entra na seleção inicial (a versão antiga fica intocada; só a
 * seleção da minor nova exclui). "Inativo" = `from.contacts` (lex #7 C5 — a MESMA leitura resolvida
 * pela célula de origem, nunca uma checagem própria aqui) marca `inactive:true`, OU não tem
 * entrada nenhuma pra esse `kind`/`id` (a única forma disso acontecer é anomalia de dado — a 429
 * grava 1 ligação por `contactRefs`/`careTeamIds` e `resolve()` devolve 1 `contacts` por ligação).
 * Contato ATIVO mas REDIGIDO (`redacted:true`, sem célula de origem pra resolver nome/telefone)
 * TEM entrada em `contacts` — não cai aqui, a referência é MANTIDA (decisão do Gabriel: "não some").
 */
const isInactiveOnEdit = (from: TherapeuticProjectVersion | null, kind: ResolvedTherapeuticContactKind, id: string): boolean => {
  const entry = from?.contacts.find((c) => c.kind === kind && c.id === id);
  return !entry || ('inactive' in entry && entry.inactive === true);
};

const keptIdsOfKind = (from: TherapeuticProjectVersion | null, refs: ContactRef[] | undefined, kind: ContactRefKind): string[] =>
  idsOfKind(refs, kind).filter((id) => !isInactiveOnEdit(from, kind, id));

const keptCareTeamIds = (from: TherapeuticProjectVersion | null): string[] =>
  (from?.careTeamIds ?? []).filter((id) => !isInactiveOnEdit(from, 'CARE_TEAM', id));

/** Quantos ids de cada `kind` saíram da seleção inicial por estarem inativos — só o AVISO precisa disso. */
const removedInactiveByKind = (from: TherapeuticProjectVersion | null): { kind: ResolvedTherapeuticContactKind; count: number }[] => {
  const groups: [ResolvedTherapeuticContactKind, string[]][] = [
    ['RESPONSIBLE', idsOfKind(from?.contactRefs, 'RESPONSIBLE')],
    ['EXTERNAL', idsOfKind(from?.contactRefs, 'EXTERNAL')],
    ['COVERAGE', idsOfKind(from?.contactRefs, 'COVERAGE')],
    ['CARE_TEAM', from?.careTeamIds ?? []],
  ];
  return groups
    .map(([kind, ids]) => ({ kind, count: ids.filter((id) => isInactiveOnEdit(from, kind, id)).length }))
    .filter((g) => g.count > 0);
};

export function TherapeuticProjectForm({
  services,
  patientDiagnoses,
  catalogs,
  fieldClass,
  responsibles,
  externalContacts,
  coverageEmergencyContacts,
  professionals,
  from,
  saving,
  saveError,
  onSubmit,
  onCancel,
  onDirty,
}: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.therapeuticProjectCard.${k}`, o ?? {});
  const tf = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.therapeuticProjectForm.${k}`, o ?? {});

  // D328/ADR-4: só em `mode:'edit'` (from !== null) os campos MACRO travam; "Novo" (from === null)
  // nunca trava nada. `fieldClass.macro` é a lista da API — nenhum nome de campo hardcoded aqui.
  const isEditing = from !== null;
  const isMacroLocked = (field: string): boolean => isEditing && fieldClass.macro.includes(field);

  const activeServices = services.filter((s) => s.active);
  const [contractedServiceId, setContractedServiceId] = useState(from?.contractedServiceId ?? activeServices[0]?.id ?? '');
  // D301 (Ana 08/09): modalidade obrigatória na versão nova; versão anterior à 417 chega `null` — o humano escolhe.
  const [modality, setModality] = useState<TherapeuticModality | ''>(from?.modality ?? '');
  const [diagnoses, setDiagnoses] = useState<TherapeuticDiagnosis[]>(
    from?.diagnoses ?? patientDiagnoses.filter((d) => d.active).map((d) => ({ uri: d.uri, title: d.title })),
  );
  const [clinicalContext, setClinicalContext] = useState(from?.clinicalContext ?? '');
  const [generalObjective, setGeneralObjective] = useState(from?.generalObjective ?? '');
  const [specificObjectiveIds, setSpecificObjectiveIds] = useState<string[]>(from?.specificObjectives.map((o) => o.id) ?? []);
  const [activityIds, setActivityIds] = useState<string[]>(from?.activities.map((a) => a.id) ?? []);
  const [startDate, setStartDate] = useState(from?.startDate ?? today());
  const [endDate, setEndDate] = useState(from?.endDate ?? '');
  // MICRO (PR-7): contato por seleção, sempre editável — "Nuevo" começa em branco. Editando a
  // vigente, contato já INATIVO na origem fica de fora (`keptIdsOfKind`/`keptCareTeamIds`, decisão
  // do Gabriel 14/09) — o aviso abaixo (`tp-form-contact-removed`) lista quantos/quais kinds saíram.
  const [responsibleIds, setResponsibleIds] = useState<string[]>(keptIdsOfKind(from, from?.contactRefs, 'RESPONSIBLE'));
  const [externalIds, setExternalIds] = useState<string[]>(keptIdsOfKind(from, from?.contactRefs, 'EXTERNAL'));
  const [coverageIds, setCoverageIds] = useState<string[]>(keptIdsOfKind(from, from?.contactRefs, 'COVERAGE'));
  const [careTeamIds, setCareTeamIds] = useState<string[]>(keptCareTeamIds(from));
  const removedInactiveContacts = removedInactiveByKind(from);
  // Filtro de segmento (US-17) — só UI, nunca vai no corpo; escondido com catálogo vazio (contrato).
  const [segmentFilter, setSegmentFilter] = useState('');

  const touch = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); onDirty(); };

  const clinicalRedacted = from?.redacted?.clinical === true;
  const errors: string[] = [];
  if (!contractedServiceId) errors.push('service');
  if (!modality) errors.push('modality');
  if (diagnoses.length === 0) errors.push('diagnoses');
  if (clinicalContext.trim().length === 0) errors.push('clinicalContext');
  if (generalObjective.trim().length === 0) errors.push('generalObjective');
  if (specificObjectiveIds.length === 0) errors.push('specificObjectives');
  if (activityIds.length === 0) errors.push('activities');
  if (!startDate || !endDate || endDate < startDate) errors.push('dates');
  const canSave = errors.length === 0 && !saving && !clinicalRedacted;

  const addDiagnosis = (c: { uri: string; title: string }): void => {
    if (diagnoses.some((d) => d.uri === c.uri)) return;
    touch(setDiagnoses)([...diagnoses, { uri: c.uri, title: c.title }]);
  };

  const hasSegmentCatalog = catalogs.segments.length > 0;
  const bySegment = (items: { id: string; label: string; segmentId?: string | null }[]) =>
    segmentFilter ? items.filter((i) => i.segmentId === segmentFilter) : items;

  /** Ids escolhidos que já não estão ativos no catálogo (versão antiga) continuam visíveis como opção. */
  const optionsOf = (kind: 'specific-objectives' | 'activities', chosen: { id: string; label: string }[] | undefined) => {
    const base = bySegment(catalogs[kind]).map((i) => ({ value: i.id, label: i.label }));
    for (const c of chosen ?? []) if (!base.some((b) => b.value === c.id)) base.push({ value: c.id, label: c.label });
    return base;
  };

  const contactOptionsOf = (items: { id: string; label: string }[]) => items.map((i) => ({ value: i.id, label: i.label }));
  /** Serviço travado (MACRO): busca em TODOS os serviços, não só ativos — a versão antiga pode ter sido feita com um serviço já desativado. */
  const lockedServiceLabel = (): string => {
    const svc = services.find((s) => s.id === contractedServiceId);
    return svc ? t(`admin.patients.detail.contractedServicesCard.serviceTypes.${svc.serviceCode}`, svc.serviceCode) : contractedServiceId;
  };
  const responsibleLabel = (r: PatientResponsibleDetail) =>
    [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || r.relationship || r.id;
  // Mesma chave i18n do editor de cobertura (`CoverageEmergencyContactsEditor.tsx`) — não duplica rótulo.
  const coverageLabel = (c: PatientCoverageEmergencyContact) =>
    `${c.name} · ${t(`admin.patients.detail.coverageCard.emergencyContactKinds.${c.kind}`)}`;
  const professionalLabel = (p: PatientProfessionalDetail) => p.name ?? tc('serviceUnknown');
  /** Rótulo do `kind` pro aviso de contato removido — as MESMAS chaves dos labels dos campos, sem duplicar i18n. */
  const contactKindLabel = (kind: ResolvedTherapeuticContactKind): string => {
    if (kind === 'RESPONSIBLE') return tf('responsibles');
    if (kind === 'EXTERNAL') return tf('externalContacts');
    if (kind === 'COVERAGE') return tf('coverageContacts');
    return tf('careTeam');
  };

  /** MACRO travado (D328/R5): TEXTO, nunca input `disabled`/`readOnly`. */
  const lockedText = (text: string, testId: string) => (
    <Text as="p" size="sm" color="primary" className="whitespace-pre-wrap" data-clarity-mask="True" data-testid={testId}>{text}</Text>
  );
  const lockedList = (items: { id: string; label: string }[], testId: string) =>
    items.length === 0
      ? <Text as="span" size="sm" color="muted" data-testid={testId}>—</Text>
      : (
        <ul className="list-disc pl-5" data-testid={testId}>
          {items.map((i) => <li key={i.id}><Text as="span" size="sm" color="primary">{i.label}</Text></li>)}
        </ul>
      );

  return (
    <form
      className="flex flex-col gap-6"
      data-testid="therapeutic-project-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSave) return;
        const contactRefs: ContactRef[] = [
          ...responsibleIds.map((id) => ({ kind: 'RESPONSIBLE' as const, id })),
          ...externalIds.map((id) => ({ kind: 'EXTERNAL' as const, id })),
          ...coverageIds.map((id) => ({ kind: 'COVERAGE' as const, id })),
        ];
        // `canSave` já exige modalidade escolhida; o cast só fecha o tipo (`'' | TherapeuticModality`).
        onSubmit({
          contractedServiceId,
          modality: modality as TherapeuticModality,
          diagnoses,
          clinicalContext: clinicalContext.trim(),
          generalObjective: generalObjective.trim(),
          specificObjectiveIds,
          activityIds,
          startDate,
          endDate,
          contactRefs,
          careTeamIds,
        });
      }}
    >
      {clinicalRedacted && (
        <Text size="sm" className="text-amber-700" data-testid="tp-form-redacted">{tf('redactedCannotEdit')}</Text>
      )}
      {removedInactiveContacts.length > 0 && (
        <Text size="sm" className="text-amber-700" data-testid="tp-form-contact-removed">
          {tf('contactRemovedInactive', {
            kinds: removedInactiveContacts.map((g) => `${contactKindLabel(g.kind)} (${g.count})`).join(', '),
          })}
        </Text>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-6">
        <div className="flex flex-col gap-6">
          <FormField label={tf('service')} htmlFor="tp-service" labelSize="compact" required={!isMacroLocked('contractedServiceId')}>
            {isMacroLocked('contractedServiceId')
              ? lockedText(lockedServiceLabel(), 'tp-service-locked')
              : (
                <>
                  <Select
                    id="tp-service"
                    inputSize="compact"
                    value={contractedServiceId}
                    onValueChange={touch(setContractedServiceId)}
                    placeholder={tf('servicePlaceholder')}
                    options={activeServices.map((s) => ({
                      value: s.id,
                      label: `${t(`admin.patients.detail.contractedServicesCard.serviceTypes.${s.serviceCode}`, s.serviceCode)}${s.weeklyHours != null ? ` · ${s.weeklyHours} h/sem` : ''}`,
                    }))}
                    data-testid="tp-service"
                  />
                  {activeServices.length === 0 && <Text size="xs" className="text-amber-700" data-testid="tp-no-service">{tf('noActiveService')}</Text>}
                </>
              )}
          </FormField>

          <FormField label={tc('modality')} htmlFor="tp-modality" labelSize="compact" required>
            <Select
              id="tp-modality"
              inputSize="compact"
              value={modality}
              onValueChange={(v) => touch(setModality)(v as TherapeuticModality)}
              placeholder={tf('modalityPlaceholder')}
              options={THERAPEUTIC_MODALITIES.map((m) => ({ value: m, label: t(`admin.patients.detail.therapeuticProjectCard.modalityOptions.${m}`, m) }))}
              data-testid="tp-modality"
            />
          </FormField>

          <div className="flex flex-col gap-2" data-testid="tp-diagnoses">
            <FormField label={tc('cid')} htmlFor="tp-icd" labelSize="compact" required={!isMacroLocked('diagnoses')}>
              {!isMacroLocked('diagnoses') && <IcdSearchCombobox id="tp-icd" onSelect={addDiagnosis} disabled={saving} />}
            </FormField>
            <ul className="flex flex-wrap gap-2" data-clarity-mask="True">
              {diagnoses.map((d) => (
                <li key={d.uri} className="inline-flex items-center gap-2 rounded-lg border border-gray-600 px-3 py-1.5" data-testid="tp-diagnosis-chip">
                  <Text as="span" size="sm" color="primary">{d.title}</Text>
                  {!isMacroLocked('diagnoses') && (
                    <button type="button" onClick={() => touch(setDiagnoses)(diagnoses.filter((x) => x.uri !== d.uri))} aria-label={tf('removeDiagnosis', { title: d.title })} className="text-gray-700 hover:text-red-600">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {isMacroLocked('clinicalContext')
            ? <FormField label={tc('currentClinicalContext')} labelSize="compact">{lockedText(clinicalContext, 'tp-clinicalContext-locked')}</FormField>
            : (
              // O campo é não-controlado (molde `register`): `defaultValue` é o que enche o textarea; `value` só alimenta o contador.
              <ClinicalTextareaField id="tp-clinicalContext" label={tc('currentClinicalContext')} value={clinicalContext} defaultValue={clinicalContext} maxChars={THERAPEUTIC_TEXT_MAX} rows={6} onChange={(e) => touch(setClinicalContext)(e.target.value)} disabled={clinicalRedacted} />
            )}
          {isMacroLocked('generalObjective')
            ? <FormField label={tc('generalObjective')} labelSize="compact">{lockedText(generalObjective, 'tp-generalObjective-locked')}</FormField>
            : (
              <ClinicalTextareaField id="tp-generalObjective" label={tc('generalObjective')} value={generalObjective} defaultValue={generalObjective} maxChars={THERAPEUTIC_TEXT_MAX} rows={5} onChange={(e) => touch(setGeneralObjective)(e.target.value)} disabled={clinicalRedacted} />
            )}
        </div>

        <div className="flex flex-col gap-6">
          {hasSegmentCatalog && (
            <FormField label={tf('segmentFilter')} htmlFor="tp-segment" labelSize="compact">
              <Select
                id="tp-segment"
                inputSize="compact"
                value={segmentFilter}
                onValueChange={setSegmentFilter}
                placeholder={tf('segmentFilterPlaceholder')}
                options={[{ value: '', label: tf('segmentFilterAll') }, ...catalogs.segments.map((s) => ({ value: s.id, label: s.label }))]}
                data-testid="tp-segment-filter"
              />
            </FormField>
          )}

          <FormField label={tc('specificObjectives')} htmlFor="tp-specificObjectives" labelSize="compact" required={!isMacroLocked('specificObjectiveIds')}>
            {/* `isMacroLocked` só é `true` com `isEditing` (⇒ `from !== null`, checado ali em cima) — `from!` fecha o tipo sem reabrir um `?? []` de fato inatingível. */}
            {isMacroLocked('specificObjectiveIds')
              ? lockedList(from!.specificObjectives, 'tp-specificObjectives-locked')
              : <MultiSelect id="tp-specificObjectives" options={optionsOf('specific-objectives', from?.specificObjectives)} value={specificObjectiveIds} onChange={touch(setSpecificObjectiveIds)} placeholder={tf('selectPlaceholder')} />}
          </FormField>
          <FormField label={tc('activitiesPlan')} htmlFor="tp-activities" labelSize="compact" required={!isMacroLocked('activityIds')}>
            {isMacroLocked('activityIds')
              ? lockedList(from!.activities, 'tp-activities-locked')
              : <MultiSelect id="tp-activities" options={optionsOf('activities', from?.activities)} value={activityIds} onChange={touch(setActivityIds)} placeholder={tf('selectPlaceholder')} />}
          </FormField>
          {/* Sem "Tipo de patología": deriva dos CID-11 no servidor (Gabriel 08/09; D163/D164) — máscara invisível na tela (DEC-09). */}
          <div className="grid grid-cols-2 gap-4">
            <FormField label={tf('startDate')} htmlFor="tp-startDate" labelSize="compact" required>
              <Input id="tp-startDate" type="date" inputSize="compact" value={startDate} onChange={(e) => touch(setStartDate)(e.target.value)} data-testid="tp-startDate" />
            </FormField>
            <FormField label={tf('endDate')} htmlFor="tp-endDate" labelSize="compact" required error={endDate && endDate < startDate ? tf('endBeforeStart') : undefined}>
              <Input id="tp-endDate" type="date" inputSize="compact" value={endDate} onChange={(e) => touch(setEndDate)(e.target.value)} data-testid="tp-endDate" />
            </FormField>
          </div>

          {/* Contato por seleção (PR-7, MICRO — sempre editável): só ativos, já filtrados pelo servidor. */}
          <FormField label={tf('responsibles')} htmlFor="tp-responsibles" labelSize="compact">
            <MultiSelect id="tp-responsibles" options={contactOptionsOf(responsibles.map((r) => ({ id: r.id, label: responsibleLabel(r) })))} value={responsibleIds} onChange={touch(setResponsibleIds)} placeholder={tf('selectPlaceholder')} />
          </FormField>
          <FormField label={tf('externalContacts')} htmlFor="tp-externalContacts" labelSize="compact">
            <MultiSelect id="tp-externalContacts" options={contactOptionsOf(externalContacts.map((c) => ({ id: c.id, label: c.name })))} value={externalIds} onChange={touch(setExternalIds)} placeholder={tf('selectPlaceholder')} />
          </FormField>
          <FormField label={tf('coverageContacts')} htmlFor="tp-coverageContacts" labelSize="compact">
            <MultiSelect id="tp-coverageContacts" options={contactOptionsOf(coverageEmergencyContacts.map((c) => ({ id: c.id, label: coverageLabel(c) })))} value={coverageIds} onChange={touch(setCoverageIds)} placeholder={tf('selectPlaceholder')} />
          </FormField>
          <FormField label={tf('careTeam')} htmlFor="tp-careTeam" labelSize="compact">
            <MultiSelect id="tp-careTeam" options={contactOptionsOf(professionals.map((p) => ({ id: p.id, label: professionalLabel(p) })))} value={careTeamIds} onChange={touch(setCareTeamIds)} placeholder={tf('selectPlaceholder')} />
          </FormField>
        </div>
      </div>

      {saveError && (
        <div className="border border-red-300 bg-red-50 rounded-lg px-4 py-3" role="alert" data-testid="tp-form-error">
          <Text size="sm" className="text-red-700">{saveError}</Text>
        </div>
      )}

      <div className="flex justify-end gap-3 pt-2 border-t border-slate-100">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!canSave} data-testid="tp-save">
          {saving ? tf('saving') : tf('save')}
        </Button>
      </div>
    </form>
  );
}
