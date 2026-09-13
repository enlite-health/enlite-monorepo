import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { ActionButton } from '@presentation/components/features/access';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { PatientGeneralEditDrawer } from './edit/PatientGeneralEditDrawer';
import { FieldPair, FieldPairGrid } from './FieldPairs';

/** Spec 018 PR-3 — a mesma lista fechada ISO de `workers.languages` (pt/es/en). */
const LANGUAGE_LABEL_KEYS: Record<string, string> = {
  pt: 'admin.patients.detail.generalInfoCard.languageOptions.pt',
  es: 'admin.patients.detail.generalInfoCard.languageOptions.es',
  en: 'admin.patients.detail.generalInfoCard.languageOptions.en',
};

interface PatientGeneralInfoCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
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
  // Spec 018 PR-3 (Emenda 13/09, migration 425): `null` = não perguntado, distinto de
  // `'PREFER_NOT_TO_SAY'` (resposta explícita) — os DOIS caem em `resolve(...) ?? null` do `t()`
  // abaixo por caminhos diferentes: null nunca chega ao `t`, PREFER_NOT_TO_SAY chega e resolve
  // para o rótulo "Prefiero no decir".
  const genderLabel = patient.gender ? t(`admin.patients.detail.generalInfoCard.genderOptions.${patient.gender}`, { defaultValue: patient.gender }) : null;
  const languagesLabel = patient.languages && patient.languages.length > 0
    ? patient.languages.map((l) => t(LANGUAGE_LABEL_KEYS[l] ?? '', { defaultValue: l })).join(', ')
    : null;

  return (
    // FR-211 (lex #3(c)/#1(g)): `data-clarity-mask` no card INTEIRO — nascimento, idade, faixa
    // etária, sexo, gênero e idiomas são dado sensível do titular; o mesmo racional dos outros
    // blocos desta ficha (o modo do dashboard do Clarity é configuração remota que ninguém aqui
    // controla).
    <div data-testid="patient-general-info-card" data-clarity-mask="True" className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
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

      <FieldPairGrid>
        <FieldPair label={t('admin.patients.detail.generalInfoCard.birthDate')} value={formatBirthDate(patient.birthDate)} />
        <FieldPair label={t('admin.patients.detail.generalInfoCard.age')} value={ageDisplay} />
        <FieldPair label={t('admin.patients.detail.generalInfoCard.ageBracket')} value={ageBracket} />
        <FieldPair label={t('admin.patients.detail.generalInfoCard.sex')} value={sexLabel} testId="patient-sex" />
        {/* US-B9 (spec 012): data de início do serviço — nativa do painel, não deriva da vaga. */}
        <FieldPair label={t('admin.patients.detail.generalInfoCard.serviceStartDate')} value={formatBirthDate(patient.serviceStartDate)} />
        {/*
         * Spec 018 PR-3 (Emenda 13/09, migration 425): Gênero e Idiomas VOLTAM — a spec 014 US-D2
         * (03/09) os removeu porque `patients` não tinha coluna própria (só `workers` tinha,
         * migrations 008/023/002). A migration 425 cria `gender_encrypted`/`languages_encrypted`
         * cifrados com KMS, coleta SEMPRE facultativa, sob `patient_identity:read` — a razão que
         * bloqueava (dado sem base legal/sem coluna) não existe mais.
         *
         * Orientação sexual, origem racial e religião CONTINUAM fora (lex #2a, PARE) — nenhuma
         * das duas ganhou coluna nesta migration nem em nenhuma outra.
         */}
        <FieldPair label={t('admin.patients.detail.generalInfoCard.gender')} value={genderLabel} testId="patient-gender" />
        <FieldPair label={t('admin.patients.detail.generalInfoCard.languages')} value={languagesLabel} testId="patient-languages" />
      </FieldPairGrid>
    </div>
  );
}
