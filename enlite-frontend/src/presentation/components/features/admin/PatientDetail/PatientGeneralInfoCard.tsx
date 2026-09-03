import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { PatientGeneralEditDrawer } from './edit/PatientGeneralEditDrawer';

interface PatientGeneralInfoCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <Text size="sm" className="leading-snug">
      <Text as="span" size="sm" weight="medium" color="secondary">{label} </Text>
      <Text as="span" size="sm" color="muted">{value ?? '—'}</Text>
    </Text>
  );
}

function calculateAge(birthDateIso: string | null): number | null {
  if (!birthDateIso) return null;
  // `new Date(...)` e os getters nunca lançam: um try/catch aqui era ramo morto (spec 012, DoD 100%).
  const birth = new Date(birthDateIso);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
    age -= 1;
  }
  return age;
}

function getAgeBracket(age: number | null): string | null {
  if (age === null) return null;
  if (age < 3) return '0-2';
  if (age < 13) return '3-12';
  if (age < 18) return '13-17';
  if (age < 30) return '18-29';
  if (age < 60) return '30-59';
  return '60+';
}

function formatBirthDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('es-AR');
  } catch {
    return iso;
  }
}

export function PatientGeneralInfoCard({ patient, onSaved }: PatientGeneralInfoCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);

  const age = calculateAge(patient.birthDate);
  const ageBracket = getAgeBracket(age);
  const sexLabel = patient.sex ? t(`admin.patients.detail.sex.${patient.sex}`) : null;

  const ageDisplay = age !== null ? t('admin.patients.detail.generalInfoCard.ageYears', { count: age }) : null;

  return (
    <div className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.generalInfoCard.title')}
        </Heading>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="w-28" data-testid="edit-general-btn">
          {t('admin.patients.detail.edit')}
        </Button>
      </div>

      {editing && (
        <PatientGeneralEditDrawer
          patient={patient}
          onClose={() => setEditing(false)}
          onSaved={() => onSaved?.()}
        />
      )}

      <div className="flex flex-col gap-2.5">
        <Field label={`${t('admin.patients.detail.generalInfoCard.birthDate')}:`} value={formatBirthDate(patient.birthDate)} />
        <Field label={`${t('admin.patients.detail.generalInfoCard.age')}:`} value={ageDisplay} />
        <Field label={`${t('admin.patients.detail.generalInfoCard.ageBracket')}:`} value={ageBracket} />
        <Field label={`${t('admin.patients.detail.generalInfoCard.sex')}:`} value={sexLabel} />
        {/* US-B9 (spec 012): data de início do serviço — nativa do painel, não deriva da vaga. */}
        <Field label={`${t('admin.patients.detail.generalInfoCard.serviceStartDate')}:`} value={formatBirthDate(patient.serviceStartDate)} />
        <Field label={`${t('admin.patients.detail.generalInfoCard.gender')}:`} value={null} />
        <Field label={`${t('admin.patients.detail.generalInfoCard.sexualOrientation')}:`} value={null} />
        <Field label={`${t('admin.patients.detail.generalInfoCard.racialOrigin')}:`} value={null} />
        <Field label={`${t('admin.patients.detail.generalInfoCard.religion')}:`} value={null} />
        <Field label={`${t('admin.patients.detail.generalInfoCard.languages')}:`} value={null} />
      </div>
    </div>
  );
}
