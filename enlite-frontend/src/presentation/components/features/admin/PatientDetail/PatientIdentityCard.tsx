import { useTranslation } from 'react-i18next';
import { User } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import type { PatientDetail, PatientResponsibleDetail } from '@domain/entities/PatientDetail';

interface PatientIdentityCardProps {
  patient: PatientDetail;
}

// PatientStatus v2 (spec 012, US-B7): funil de admissão + seis estados clínicos. O rótulo vem
// de `admin.patients.statusOptions.<STATUS>` (mesmo vocabulário do select, do Kanban e do Historial).
const STATUS_COLORS: Record<string, string> = {
  SOLICITANTE: 'bg-slate-100 text-slate-700',
  ADMISSION: 'bg-blue-100 text-blue-700',
  PENDING_ADMISSION: 'bg-yellow-100 text-yellow-700',
  ACTIVE: 'bg-green-100 text-green-700',
  ON_HOLD: 'bg-amber-100 text-amber-700',
  SEARCHING: 'bg-sky-100 text-sky-700',
  REPLACEMENT: 'bg-indigo-100 text-indigo-700',
  SUSPENDED: 'bg-orange-100 text-orange-700',
  DISCHARGED: 'bg-gray-100 text-gray-600',
};

function Field({ label, value, testId }: { label: string; value: string | null; testId?: string }) {
  return (
    <Text size="sm" className="leading-snug">
      <Text as="span" size="sm" weight="medium" color="secondary">{label} </Text>
      <span data-testid={testId}>
        <Text as="span" size="sm" color="muted">{value ?? '—'}</Text>
      </span>
    </Text>
  );
}

function formatDate(iso: string | null, locale = 'es-AR'): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(locale);
  } catch {
    return iso;
  }
}

function buildAddress(patient: PatientDetail): string | null {
  const addr = patient.addresses?.[0];
  // Contrato real da API (spec 011 A2): `addressFormatted`/`addressRaw`, não `fullAddress`.
  const formatted = addr?.addressFormatted ?? addr?.addressRaw;
  if (formatted) return formatted;
  const parts = [
    patient.zoneNeighborhood,
    patient.cityLocality,
    patient.province,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function ResponsibleSection({ responsible, t }: { responsible: PatientResponsibleDetail; t: (k: string) => string }) {
  const name = [responsible.firstName, responsible.lastName].filter(Boolean).join(' ') || '—';
  const docParts = [
    responsible.documentType ? t(`admin.patients.detail.documentTypes.${responsible.documentType}`) : null,
    responsible.documentNumber,
  ].filter(Boolean);
  const doc = docParts.length > 0 ? docParts.join(' ') : null;

  return (
    <div className="mt-3 flex flex-col gap-2">
      <Text size="sm" weight="semibold" color="secondary">
        {t('admin.patients.detail.identityCard.emergencyContact')}
      </Text>
      <Field label={`${t('admin.patients.detail.identityCard.responsibleName')}:`} value={name} />
      <Field label={`${t('admin.patients.detail.identityCard.responsiblePhone')}:`} value={responsible.phone} />
      <Field label={`${t('admin.patients.detail.identityCard.documentType')}:`} value={doc} />
      {responsible.email && (
        <Field label={`${t('admin.patients.detail.identityCard.email')}:`} value={responsible.email} />
      )}
    </div>
  );
}

export function PatientIdentityCard({ patient }: PatientIdentityCardProps) {
  const { t } = useTranslation();

  const fullName = [patient.firstName, patient.lastName].filter(Boolean).join(' ') || '—';
  const statusKey = patient.status ?? '';
  const statusColor = STATUS_COLORS[statusKey] ?? 'bg-gray-100 text-gray-600';
  const statusLabel = statusKey ? t(`admin.patients.statusOptions.${statusKey}`, statusKey) : '—';
  // Motivo da espera (rótulo de catálogo, não a nota): só quando o estado é ON_HOLD.
  const onHoldReasonLabel = statusKey === 'ON_HOLD' && patient.onHoldReason
    ? t(`admin.patients.onHoldReasonOptions.${patient.onHoldReason}`, patient.onHoldReason)
    : null;
  const address = buildAddress(patient);
  const primaryResponsible = patient.responsibles?.find((r) => r.isPrimary) ?? patient.responsibles?.[0] ?? null;

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="patient-identity-card"
    >
      <div className="flex items-center gap-4 mb-2">
        <div className="w-14 h-14 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 shrink-0">
          <User className="w-8 h-8" />
        </div>
        <div className="min-w-0">
          <Heading level={1} as="h3" weight="semibold" color="primary" className="truncate">
            {fullName}
          </Heading>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <span className={`inline-flex px-2.5 py-0.5 rounded-full ${statusColor}`} data-testid="patient-status-badge">
              <Text as="span" size="xs" weight="medium" color="inherit">
                {statusLabel}
              </Text>
            </span>
            {onHoldReasonLabel && (
              <span className="inline-flex px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700" data-testid="patient-on-hold-reason">
                <Text as="span" size="xs" weight="medium" color="inherit">
                  {onHoldReasonLabel}
                </Text>
              </span>
            )}
            {patient.lastCaseNumber != null && (
              <span className="inline-flex px-2.5 py-0.5 rounded-full bg-purple-100 text-purple-700">
                <Text as="span" size="xs" weight="semibold" color="inherit">
                  {t('admin.patients.detail.caseNumber')} #{patient.lastCaseNumber}
                </Text>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled className="w-28">
          {t('admin.patients.detail.edit')}
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <Field label={`${t('admin.patients.detail.identityCard.responsiblePhone')}:`} value={patient.phoneWhatsapp} />
        {/* E-mail do paciente EM CLARO (lex A4: é o contato do titular na ficha dele); a
            máscara do Clarity vai no DOM porque o modo do dashboard é configuração remota
            que ninguém aqui controla (lex C4.2). */}
        <div data-clarity-mask="True">
          <Field label={`${t('admin.patients.detail.identityCard.patientEmail')}:`} value={patient.contactEmail} testId="patient-contact-email" />
        </div>
        <Field label={`${t('admin.patients.detail.identityCard.admission')}:`} value={formatDate(patient.createdAt)} />
        <Field label={`${t('admin.patients.detail.identityCard.lastUpdate')}:`} value={formatDate(patient.updatedAt)} />
        <Field label={`${t('admin.patients.detail.identityCard.discharge')}:`} value={null} />
        {/* Rua + número é texto: o Clarity (Balanced) não mascara sozinho (lex C2.1; QA 🔴2). */}
        {address && (
          <div data-clarity-mask="True">
            <Field label={t('admin.patients.detail.identityCard.address')} value={address} testId="patient-address" />
          </div>
        )}
      </div>

      {primaryResponsible && (
        <div className="border-t border-gray-200 pt-4">
          <ResponsibleSection responsible={primaryResponsible} t={t} />
        </div>
      )}
    </div>
  );
}
