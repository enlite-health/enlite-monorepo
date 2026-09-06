/**
 * PatientServiceEditDrawer — arquivo pré-existente SEM teste dedicado antes desta sessão
 * (spec 014, D200: cobertura 100% do arquivo tocado). Edita `service_type` (multi-select) via
 * PATCH /api/admin/patients/:id/service. Também cobre US-D4 (lex D4 AUTORIZADO): fechar por
 * Esc/backdrop/X com mudança pendente pede confirmação; sem mudança fecha direto; salvar nunca
 * pergunta.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { patientDetailFixture } from '../../__tests__/patientDetailFixture';

const updatePatientSection = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    updatePatientSection: (...a: unknown[]) => updatePatientSection(...a),
  },
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

import { PatientServiceEditDrawer } from '../PatientServiceEditDrawer';

const patient = { ...patientDetailFixture, serviceType: ['AT'] };

describe('PatientServiceEditDrawer', () => {
  beforeEach(() => {
    updatePatientSection.mockReset().mockResolvedValue({ id: patient.id });
  });

  it('renderiza com o serviceType atual pré-selecionado', () => {
    render(<PatientServiceEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('patient-service-edit-drawer')).toBeVisible();
    const btn = document.querySelector('#psv-serviceType button') as HTMLElement;
    expect(btn).toHaveTextContent('Acompañante Terapéutico');
  });

  it('trocar o serviço e salvar chama updatePatientSection só com o payload novo', async () => {
    const onSaved = vi.fn();
    render(<PatientServiceEditDrawer patient={patient} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(document.querySelector('#psv-serviceType button') as HTMLElement);
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(screen.getByRole('option', { name: /Cuidador/i }).querySelector('button') as HTMLElement);
    expect(listbox).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('psv-save'));
    await waitFor(() =>
      expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'service', { serviceType: ['AT', 'CAREGIVER'] }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('erro no PATCH mostra a mensagem em pce-error (psv-error)', async () => {
    updatePatientSection.mockRejectedValueOnce(new Error('falha de rede'));
    render(<PatientServiceEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('psv-save'));
    expect(await screen.findByTestId('psv-error')).toHaveTextContent('falha de rede');
  });

  it('erro NÃO-Error (ex.: rejeição de string) cai no fallback genérico (te(saveError))', async () => {
    updatePatientSection.mockRejectedValueOnce('plain string rejection');
    render(<PatientServiceEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('psv-save'));
    expect(await screen.findByTestId('psv-error')).toHaveTextContent('Error al guardar');
  });

  it('paciente sem serviceType (null) → multi-select nasce vazio', () => {
    render(<PatientServiceEditDrawer patient={{ ...patient, serviceType: null }} onClose={vi.fn()} onSaved={vi.fn()} />);
    const btn = document.querySelector('#psv-serviceType button') as HTMLElement;
    expect(btn).toHaveTextContent('Seleccioná…');
  });

  it('SEM mudança → Escape fecha direto, sem confirmação', async () => {
    const onClose = vi.fn();
    render(<PatientServiceEditDrawer patient={patient} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1000 });
  });

  it('COM mudança → Escape abre confirmação; backdrop e X seguem a mesma régua', async () => {
    render(<PatientServiceEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(document.querySelector('#psv-serviceType button') as HTMLElement);
    await screen.findByRole('listbox');
    fireEvent.click(screen.getByRole('option', { name: /Cuidador/i }).querySelector('button') as HTMLElement);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
    fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
    expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('patient-service-edit-backdrop'));
    expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
    fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));

    fireEvent.click(screen.getByLabelText('Cerrar'));
    expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
  });

  it('"Descartar cambios" fecha de verdade', async () => {
    const onClose = vi.fn();
    render(<PatientServiceEditDrawer patient={patient} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(document.querySelector('#psv-serviceType button') as HTMLElement);
    await screen.findByRole('listbox');
    fireEvent.click(screen.getByRole('option', { name: /Cuidador/i }).querySelector('button') as HTMLElement);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('discard-changes-discard'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1000 });
  });

  it('SALVAR nunca pergunta, mesmo com mudança pendente', async () => {
    const onSaved = vi.fn();
    render(<PatientServiceEditDrawer patient={patient} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(document.querySelector('#psv-serviceType button') as HTMLElement);
    await screen.findByRole('listbox');
    fireEvent.click(screen.getByRole('option', { name: /Cuidador/i }).querySelector('button') as HTMLElement);
    fireEvent.click(screen.getByTestId('psv-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
  });
});
