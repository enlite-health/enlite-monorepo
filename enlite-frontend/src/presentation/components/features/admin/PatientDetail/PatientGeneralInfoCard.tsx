import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
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
    <div data-testid="patient-general-info-card" className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.generalInfoCard.title')}
        </Heading>
        {/* D269 — abre o drawer que faz PATCH /patients/:id/general → patient:write. */}
        <ActionButton resource="patient_identity" action="write" variant="outline" size="sm" onClick={() => setEditing(true)} className="w-28" data-testid="edit-general-btn">
          {t('admin.patients.detail.edit')}
        </ActionButton>
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
        {/* Spec 014 US-D2 (decisão Gabriel 03/09, item 9): Género/Orientación Sexual/Origen
            racial/Religión/Idiomas REMOVIDOS — eram `value={null}` fixo, sem coluna em `patients`
            (só existem em `workers`; ver lex D2 e migrations/008,023,002). Manter o rótulo sem o
            dado não é só promessa vazia: é convite a coletar dado sensível sem base legal. */}
      </div>
    </div>
  );
}
