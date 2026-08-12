import { useTranslation } from 'react-i18next';
import { User } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import type { PatientDetail, PatientResponsibleDetail } from '@domain/entities/PatientDetail';

interface PatientIdentityCardProps {
  patient: PatientDetail;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING_ADMISSION: 'bg-yellow-100 text-yellow-700',
  ACTIVE: 'bg-green-100 text-green-700',
  SUSPENDED: 'bg-orange-100 text-orange-700',
  DISCONTINUED: 'bg-red-100 text-red-700',
  DISCHARGED: 'bg-gray-100 text-gray-600',
  EM_ADMISSAO: 'bg-yellow-100 text-yellow-700',
  EM_ATENDIMENTO: 'bg-green-100 text-green-700',
  PACIENTE_COM_ALTA: 'bg-gray-100 text-gray-600',
  CANCELADO: 'bg-red-100 text-red-700',
};

const STATUS_I18N_MAP: Record<string, string> = {
  PENDING_ADMISSION: 'admin.patients.detail.patientStatus.EM_ADMISSAO',
  ACTIVE: 'admin.patients.detail.patientStatus.EM_ATENDIMENTO',
  SUSPENDED: 'admin.patients.detail.patientStatus.EM_ATENDIMENTO',
  DISCONTINUED: 'admin.patients.detail.patientStatus.CANCELADO',
  DISCHARGED: 'admin.patients.detail.patientStatus.PACIENTE_COM_ALTA',
  EM_ADMISSAO: 'admin.patients.detail.patientStatus.EM_ADMISSAO',
  EM_ATENDIMENTO: 'admin.patients.detail.patientStatus.EM_ATENDIMENTO',
  PACIENTE_COM_ALTA: 'admin.patients.detail.patientStatus.PACIENTE_COM_ALTA',
  CANCELADO: 'admin.patients.detail.patientStatus.CANCELADO',
};

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <Text size="sm" className="leading-snug">
      <Text as="span" size="sm" weight="medium" color="secondary">{label} </Text>
      <Text as="span" size="sm" color="muted">{value ?? '—'}</Text>
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
  if (addr?.fullAddress) return addr.fullAddress;
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
  const statusLabel = STATUS_I18N_MAP[statusKey] ? t(STATUS_I18N_MAP[statusKey]) : statusKey || '—';
  const address = buildAddress(patient);
  const primaryResponsible = patient.responsibles?.find((r) => r.isPrimary) ?? patient.responsibles?.[0] ?? null;

  return (
    <div className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <div className="flex items-center gap-4 mb-2">
        <div className="w-14 h-14 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 shrink-0">
          <User className="w-8 h-8" />
        </div>
        <div className="min-w-0">
          <Heading level={1} as="h3" weight="semibold" color="primary" className="truncate">
            {fullName}
          </Heading>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <span className={`inline-flex px-2.5 py-0.5 rounded-full ${statusColor}`}>
              <Text as="span" size="xs" weight="medium" color="inherit">
                {statusLabel}
              </Text>
            </span>
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
        <Button variant="outline" size="sm" disabled onClick={() => {}} className="w-28">
          {t('admin.patients.detail.edit')}
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <Field label={`${t('admin.patients.detail.identityCard.responsiblePhone')}:`} value={patient.phoneWhatsapp} />
        <Field label={`${t('admin.patients.detail.identityCard.admission')}:`} value={formatDate(patient.createdAt)} />
        <Field label={`${t('admin.patients.detail.identityCard.lastUpdate')}:`} value={formatDate(patient.updatedAt)} />
        <Field label={`${t('admin.patients.detail.identityCard.discharge')}:`} value={null} />
        {address && (
          <Field label="Endereço:" value={address} />
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
