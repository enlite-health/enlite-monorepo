/**
 * Spec 064 (T4): o cartão de identidade mostra "Cobertura actual" e "Ingreso al servicio".
 * i18n REAL (es + pt-BR). Rodar com TZ=America/Argentina/Buenos_Aires: a data é formatada por
 * `formatDateFromISO` (sem `new Date`), então `2026-01-05` tem de aparecer como 05/01/2026.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientDetail, CurrentCoverageSummary } from '@domain/entities/PatientDetail';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { patientDetailFixture } from './patientDetailFixture';
import { PatientIdentityCard } from '../PatientIdentityCard';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const cobertura = (patch: Partial<CurrentCoverageSummary> = {}): CurrentCoverageSummary => ({
  providers: [{ code: 'OSDE', name: 'OSDE' }],
  privateServices: 0,
  hiddenServices: 0,
  unlinkedServices: 0,
  activeServices: 1,
  ...patch,
});
const renderCard = (patch: Partial<PatientDetail>) => {
  // `delete` para os casos "campo ausente": `undefined` explícito também vale, mas ausente é o fio real.
  const patient = { ...patientDetailFixture, ...patch } as PatientDetail;
  return render(<PatientIdentityCard patient={patient} />);
};

describe('PatientIdentityCard — cobertura atual e data de entrada (spec 064)', () => {
  it('mostra a obra social e a data de entrada', () => {
    const { container } = renderCard({ currentCoverage: cobertura(), entryDate: '2026-01-05' });
    expect(screen.getByTestId('patient-current-coverage')).toHaveTextContent('OSDE');
    const entry = screen.getByTestId('patient-entry-date');
    expect(entry).toHaveTextContent('05/01/2026');
    expect(entry).not.toHaveTextContent('04/01/2026');
    expectNoRawEnumLeaks(container);
  });

  it('duas obras sociais viram lista', () => {
    renderCard({
      currentCoverage: cobertura({ providers: [{ code: 'OSDE', name: 'OSDE' }, { code: 'SWISS', name: 'Swiss Medical' }], activeServices: 2 }),
      entryDate: '2026-01-05',
    });
    expect(screen.getByTestId('patient-current-coverage')).toHaveTextContent('OSDE, Swiss Medical');
  });

  it('sem permissão => "Sin permiso"/"Sem permissão" e não "—"', async () => {
    const { unmount } = renderCard({ currentCoverage: null, entryDate: null });
    for (const id of ['patient-current-coverage', 'patient-entry-date']) {
      expect(screen.getByTestId(id)).toHaveTextContent('Sin permiso');
      expect(screen.getByTestId(id)).not.toHaveTextContent('—');
    }
    unmount();
    await i18n.changeLanguage('pt-BR');
    renderCard({ currentCoverage: null, entryDate: null });
    expect(screen.getByTestId('patient-current-coverage')).toHaveTextContent('Sem permissão');
    expect(screen.getByTestId('patient-entry-date')).toHaveTextContent('Sem permissão');
    await i18n.changeLanguage('es');
  });

  it('sem data de início => texto de apoio, não "—" seco', () => {
    renderCard({ currentCoverage: cobertura({ providers: [], unlinkedServices: 1 }), entryDate: null });
    expect(screen.getByTestId('patient-entry-date')).toHaveTextContent('Sin fecha de inicio en los servicios');
    expect(screen.getByTestId('patient-current-coverage')).toHaveTextContent('Sin obra social vinculada');
  });

  it('backend anterior (campos ausentes) => Indisponível, não vazio', () => {
    const { currentCoverage: _c, entryDate: _e, ...semCampos } = patientDetailFixture;
    render(<PatientIdentityCard patient={semCampos as PatientDetail} />);
    expect(screen.getByTestId('patient-current-coverage')).toHaveTextContent('No disponible');
    expect(screen.getByTestId('patient-entry-date')).toHaveTextContent('No disponible');
  });

  it('pt-BR e es têm as mesmas chaves novas', () => {
    const keys = ['currentCoverage', 'currentCoverageNoService', 'currentCoverageUnlinked', 'currentCoveragePrivate', 'currentCoverageHidden', 'currentCoverageSomeUnlinked_one', 'currentCoverageSomeUnlinked_other', 'entryDate', 'entryDateEmpty', 'noPermission', 'unavailable'];
    const es = esJson.admin.patients.detail.identityCard as Record<string, unknown>;
    const pt = ptBRJson.admin.patients.detail.identityCard as Record<string, unknown>;
    for (const k of keys) {
      expect(typeof es[k], `es.${k}`).toBe('string');
      expect(typeof pt[k], `pt-BR.${k}`).toBe('string');
    }
    const { container } = renderCard({ currentCoverage: cobertura({ privateServices: 1, hiddenServices: 1, unlinkedServices: 2 }), entryDate: '2026-01-05' });
    expect(screen.getByTestId('patient-current-coverage')).toHaveTextContent('OSDE · Particular · Obra social (sin acceso al nombre) · 2 servicios sin obra social');
    expectNoRawEnumLeaks(container);
  });
});
