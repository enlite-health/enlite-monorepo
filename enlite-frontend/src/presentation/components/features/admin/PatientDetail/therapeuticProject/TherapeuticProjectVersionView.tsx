/**
 * TherapeuticProjectVersionView — UMA versão em leitura (modo `view` do drawer e o topo do card).
 * Texto clínico e CID chegam `null` com `redacted.clinical` quando falta `patient_clinical:read`
 * (lex C7): mostra o rótulo de redigido, nunca vazio. `data-clarity-mask` no texto clínico (C6).
 */
import { useTranslation } from 'react-i18next';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import type { TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
import { Text } from '@presentation/components/atoms/Text';
import { formatIsoDateEsAr } from './pdf/therapeuticProjectPdfInput';

interface Props {
  version: TherapeuticProjectVersion;
  services: PatientContractedServiceDetail[];
  /** Compacto = o resumo do card (Figma `6390:13229`); completo = o drawer. */
  compact?: boolean;
  /** O ator não tem `patient_services:read`: `services` chega `[]` por REDAÇÃO, não por ausência (D113). */
  servicesRedacted?: boolean;
}

function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <Text as="span" size="sm" weight="medium" color="secondary">{label}</Text>
      <div>{children}</div>
    </div>
  );
}

function ListValue({ items }: { items: { id: string; label: string }[] }): JSX.Element {
  if (items.length === 0) return <Text as="span" size="sm" color="muted">—</Text>;
  return (
    <ul className="list-disc pl-5">
      {items.map((i) => <li key={i.id}><Text as="span" size="sm" color="primary">{i.label}</Text></li>)}
    </ul>
  );
}

export function TherapeuticProjectVersionView({ version: v, services, compact = false, servicesRedacted = false }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.therapeuticProjectCard.${k}`, o ?? {});
  const redacted = v.redacted?.clinical === true;
  const service = services.find((s) => s.id === v.contractedServiceId) ?? null;
  // `[]` por falta de célula NÃO é "serviço não encontrado" (D113: `[]` × "não posso ver").
  const serviceLabel = service
    ? t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode)
    : servicesRedacted ? tc('redacted') : tc('serviceUnknown');

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
            : <ListValue items={v.diagnoses.map((d) => ({ id: d.uri, label: d.title }))} />}
        </Row>
        <Row label={tc('service')} testId="tpv-service"><Text as="span" size="sm" color="primary">{serviceLabel}</Text></Row>
        <Row label={tc('currentClinicalContext')} testId="tpv-clinical">{clinical(v.clinicalContext, 'tpv-clinical-text')}</Row>
        <Row label={tc('generalObjective')} testId="tpv-objective">{clinical(v.generalObjective, 'tpv-objective-text')}</Row>
        <Row label={tc('specificObjectives')} testId="tpv-specific"><ListValue items={compact ? v.specificObjectives.slice(0, 3) : v.specificObjectives} /></Row>
      </div>
      <div className="flex flex-col gap-4">
        <Row label={tc('activitiesPlan')} testId="tpv-activities"><ListValue items={compact ? v.activities.slice(0, 3) : v.activities} /></Row>
        <Row label={tc('pathologyTypes')} testId="tpv-pathology">
          <Text as="span" size="sm" color="primary">{v.pathologyTypes.map((p) => p.label).join(', ') || '—'}</Text>
        </Row>
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
