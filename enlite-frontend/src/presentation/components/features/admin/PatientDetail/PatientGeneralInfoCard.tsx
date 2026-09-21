import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { ActionButton } from '@presentation/components/features/access';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { PatientGeneralEditDrawer } from './edit/PatientGeneralEditDrawer';
import { FieldPair, FieldPairGrid } from './FieldPairs';
import { formatDateFromISO } from '@presentation/hooks/useMask';

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

// Fix 21/09/2026 (Gabriel, PR #469): `new Date(birthDateIso)` decodifica a string ISO SEM hora
// como meia-noite UTC e lia a idade com getters LOCAIS — em fuso negativo (Argentina, UTC-3) a
// meia-noite UTC de "1950-03-25" já é 24/03 no relógio local, um dia a menos. `birthDate` é
// `DATE` no Postgres (sem hora, sem fuso — migrations 037/317 do worker-functions), então os
// componentes ano/mês/dia vêm do split da própria string ISO (mesmo padrão de
// `AnaCareHours/selectors.ts`), nunca de getters locais sobre um `Date` construído a partir dela.
// "Hoje" É local de verdade (não vem do backend), por isso usa `new Date()` com getters locais.
function calculateAge(birthDateIso: string | null): number | null {
  if (!birthDateIso) return null;
  const match = birthDateIso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const birthYear = Number(match[1]);
  const birthMonth = Number(match[2]) - 1;
  const birthDay = Number(match[3]);

  const today = new Date();
  let age = today.getFullYear() - birthYear;
  const m = today.getMonth() - birthMonth;
  if (m < 0 || (m === 0 && today.getDate() < birthDay)) {
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

// Fix 21/09/2026 (Gabriel): `new Date(iso).toLocaleDateString('es-AR')` decodifica a string ISO
// como meia-noite UTC e formata no fuso LOCAL — em fusos negativos (Argentina, UTC-3) isso perde
// 1 dia ("1950-03-25" virava "24/03/1950"). `birthDate` e `serviceStartDate` (as duas chamadoras
// desta função) são `DATE` no Postgres — sem hora, sem fuso (migrations 037 e 317 do
// worker-functions) — então o valor correto é o split de string do `formatDateFromISO`
// (`@presentation/hooks/useMask`, já usado no card do worker para o mesmo defeito), que nunca
// lança e devolve o valor cru quando não é ISO (nunca "Invalid Date").
function formatBirthDate(iso: string | null): string | null {
  if (!iso) return null;
  return formatDateFromISO(iso);
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
        {/* D269 — abre o drawer que faz PATCH /patients/:id/general → patient_identity:update (PR-8b). */}
        <ActionButton resource="patient_identity" action="update" variant="outline" size="sm" onClick={() => setEditing(true)} className="w-28" data-testid="edit-general-btn">
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
