/**
 * TherapeuticProjectForm — o formulário de UMA versão do projeto terapêutico (spec 017, Figma
 * `6017:14962`): serviço contratado (o operador escolhe — Gabriel 4a), CID-11 (só CID, combobox
 * existente, REQ-21: código invisível), síntese clínica, objetivo geral (texto livre — Obs3), os 3
 * multi-selects do catálogo, prazo. Sem `major`/`minor`: a numeração é do servidor.
 *
 * Rótulo "ICHOM" não existe (D299.2). `data-clarity-mask` nos textos clínicos (lex C6).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { PatientContractedServiceDetail, PatientDiagnosisDetail } from '@domain/entities/PatientDetail';
import {
  THERAPEUTIC_MODALITIES,
  THERAPEUTIC_TEXT_MAX,
  type TherapeuticDiagnosis,
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
  /** Versão de origem ("Editar") — os campos nascem dela. `null` = "Novo". */
  from: TherapeuticProjectVersion | null;
  saving: boolean;
  saveError: string | null;
  onSubmit: (body: TherapeuticProjectVersionBody) => void;
  onCancel: () => void;
  onDirty: () => void;
}

const today = (): string => new Date().toISOString().slice(0, 10);

export function TherapeuticProjectForm({ services, patientDiagnoses, catalogs, from, saving, saveError, onSubmit, onCancel, onDirty }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.therapeuticProjectCard.${k}`, o ?? {});
  const tf = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.therapeuticProjectForm.${k}`, o ?? {});

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
  const [pathologyTypeIds, setPathologyTypeIds] = useState<string[]>(from?.pathologyTypes.map((p) => p.id) ?? []);
  const [startDate, setStartDate] = useState(from?.startDate ?? today());
  const [endDate, setEndDate] = useState(from?.endDate ?? '');

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
  if (pathologyTypeIds.length === 0) errors.push('pathologyTypes');
  if (!startDate || !endDate || endDate < startDate) errors.push('dates');
  const canSave = errors.length === 0 && !saving && !clinicalRedacted;

  const addDiagnosis = (c: { uri: string; title: string }): void => {
    if (diagnoses.some((d) => d.uri === c.uri)) return;
    touch(setDiagnoses)([...diagnoses, { uri: c.uri, title: c.title }]);
  };

  /** Ids escolhidos que já não estão ativos no catálogo (versão antiga) continuam visíveis como opção. */
  const optionsOf = (kind: keyof TherapeuticCatalogs, chosen: { id: string; label: string }[] | undefined) => {
    const base = catalogs[kind].map((i) => ({ value: i.id, label: i.label }));
    for (const c of chosen ?? []) if (!base.some((b) => b.value === c.id)) base.push({ value: c.id, label: c.label });
    return base;
  };

  return (
    <form
      className="flex flex-col gap-6"
      data-testid="therapeutic-project-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSave) return;
        // `canSave` já exige modalidade escolhida; o cast só fecha o tipo (`'' | TherapeuticModality`).
        onSubmit({ contractedServiceId, modality: modality as TherapeuticModality, diagnoses, clinicalContext: clinicalContext.trim(), generalObjective: generalObjective.trim(), specificObjectiveIds, activityIds, pathologyTypeIds, startDate, endDate });
      }}
    >
      {clinicalRedacted && (
        <Text size="sm" className="text-amber-700" data-testid="tp-form-redacted">{tf('redactedCannotEdit')}</Text>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-6">
        <div className="flex flex-col gap-6">
          <FormField label={tf('service')} htmlFor="tp-service" labelSize="compact" required>
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
          </FormField>

          <FormField label={tc('modality')} htmlFor="tp-modality" labelSize="compact" required>
            <Select
              id="tp-modality"
              inputSize="compact"
              value={modality}
              onValueChange={(v) => touch(setModality)(v as TherapeuticModality)}
              placeholder={tf('modalityPlaceholder')}
              options={THERAPEUTIC_MODALITIES.map((m) => ({ value: m, label: tc(`modalityOptions.${m}`) }))}
              data-testid="tp-modality"
            />
          </FormField>

          <div className="flex flex-col gap-2" data-testid="tp-diagnoses">
            <FormField label={tc('cid')} htmlFor="tp-icd" labelSize="compact" required>
              <IcdSearchCombobox id="tp-icd" onSelect={addDiagnosis} disabled={saving} />
            </FormField>
            <ul className="flex flex-wrap gap-2" data-clarity-mask="True">
              {diagnoses.map((d) => (
                <li key={d.uri} className="inline-flex items-center gap-2 rounded-lg border border-gray-600 px-3 py-1.5" data-testid="tp-diagnosis-chip">
                  <Text as="span" size="sm" color="primary">{d.title}</Text>
                  <button type="button" onClick={() => touch(setDiagnoses)(diagnoses.filter((x) => x.uri !== d.uri))} aria-label={tf('removeDiagnosis', { title: d.title })} className="text-gray-700 hover:text-red-600">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* O campo é não-controlado (molde `register`): `defaultValue` é o que enche o textarea; `value` só alimenta o contador. */}
          <ClinicalTextareaField id="tp-clinicalContext" label={tc('currentClinicalContext')} value={clinicalContext} defaultValue={clinicalContext} maxChars={THERAPEUTIC_TEXT_MAX} rows={6} onChange={(e) => touch(setClinicalContext)(e.target.value)} disabled={clinicalRedacted} />
          <ClinicalTextareaField id="tp-generalObjective" label={tc('generalObjective')} value={generalObjective} defaultValue={generalObjective} maxChars={THERAPEUTIC_TEXT_MAX} rows={5} onChange={(e) => touch(setGeneralObjective)(e.target.value)} disabled={clinicalRedacted} />
        </div>

        <div className="flex flex-col gap-6">
          <FormField label={tc('specificObjectives')} htmlFor="tp-specificObjectives" labelSize="compact" required>
            <MultiSelect id="tp-specificObjectives" options={optionsOf('specific-objectives', from?.specificObjectives)} value={specificObjectiveIds} onChange={touch(setSpecificObjectiveIds)} placeholder={tf('selectPlaceholder')} />
          </FormField>
          <FormField label={tc('activitiesPlan')} htmlFor="tp-activities" labelSize="compact" required>
            <MultiSelect id="tp-activities" options={optionsOf('activities', from?.activities)} value={activityIds} onChange={touch(setActivityIds)} placeholder={tf('selectPlaceholder')} />
          </FormField>
          <FormField label={tc('pathologyTypes')} htmlFor="tp-pathologyTypes" labelSize="compact" required>
            <MultiSelect id="tp-pathologyTypes" options={optionsOf('pathology-types', from?.pathologyTypes)} value={pathologyTypeIds} onChange={touch(setPathologyTypeIds)} placeholder={tf('selectPlaceholder')} />
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label={tf('startDate')} htmlFor="tp-startDate" labelSize="compact" required>
              <Input id="tp-startDate" type="date" inputSize="compact" value={startDate} onChange={(e) => touch(setStartDate)(e.target.value)} data-testid="tp-startDate" />
            </FormField>
            <FormField label={tf('endDate')} htmlFor="tp-endDate" labelSize="compact" required error={endDate && endDate < startDate ? tf('endBeforeStart') : undefined}>
              <Input id="tp-endDate" type="date" inputSize="compact" value={endDate} onChange={(e) => touch(setEndDate)(e.target.value)} data-testid="tp-endDate" />
            </FormField>
          </div>
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
