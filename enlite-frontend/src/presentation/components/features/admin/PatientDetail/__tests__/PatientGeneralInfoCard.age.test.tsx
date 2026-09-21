/**
 * PatientGeneralInfoCard — `calculateAge` (PR #469, Gabriel 21/09).
 *
 * `birth_date` é DATE no Postgres (sem hora, sem fuso — migrations 037/317 do worker-functions).
 * O código antigo fazia `new Date(birthDateIso)` e lia a idade com getters LOCAIS: a string
 * `"1950-03-25"` sem hora é decodificada como meia-noite UTC, que em fuso negativo (Argentina,
 * UTC-3) já é o dia 24 no horário local — um dia a menos. Precisa rodar com
 * `TZ=America/Argentina/Buenos_Aires` (setado no processo, ver `bin/verificar-tudo` / comando de
 * teste) para o defeito se manifestar: em UTC ou fuso positivo não haveria diferença.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { patientDetailFixture } from './patientDetailFixture';
import { PatientGeneralInfoCard } from '../PatientGeneralInfoCard';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PatientGeneralInfoCard — calculateAge sem deslocamento de fuso', () => {
  it('no dia do aniversário (hoje 2026-03-25 10:00 local, nascido 1950-03-25): 76 anos', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 25, 10, 0, 0));

    render(
      <PatientGeneralInfoCard patient={{ ...patientDetailFixture, birthDate: '1950-03-25' }} />,
    );

    expect(screen.getByText('76 años')).toBeTruthy();
  });

  it('véspera, à noite (hoje 2026-03-24 22:00 local, nascido 1950-03-25): 75 anos — o código antigo dava 76 (errado)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 24, 22, 0, 0));

    render(
      <PatientGeneralInfoCard patient={{ ...patientDetailFixture, birthDate: '1950-03-25' }} />,
    );

    expect(screen.getByText('75 años')).toBeTruthy();
    expect(screen.queryByText('76 años')).toBeNull();
  });

  it('birthDate não-ISO: não piora — campo idade fica vazio ("—"), nunca "NaN años"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 25, 10, 0, 0));

    render(
      <PatientGeneralInfoCard patient={{ ...patientDetailFixture, birthDate: 'não-é-data' }} />,
    );

    expect(screen.queryByText(/años/)).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('birthDate null: idade fica vazia ("—"), como já era', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 25, 10, 0, 0));

    render(
      <PatientGeneralInfoCard patient={{ ...patientDetailFixture, birthDate: null }} />,
    );

    expect(screen.queryByText(/años/)).toBeNull();
  });
});
