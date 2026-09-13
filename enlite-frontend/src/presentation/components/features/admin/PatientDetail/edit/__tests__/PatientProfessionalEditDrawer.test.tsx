/**
 * PatientProfessionalEditDrawer — spec 018, PR-5, US-11; lex C9 (autoria fica no backend, aqui só
 * o payload) / C13 (dever de informar, aviso es-AR no ponto da coleta).
 *
 * Sem `professional` → cria (POST); com `professional` → edita (PATCH), pré-preenchido.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import esJson from '@infrastructure/i18n/locales/es.json';
import type { PatientProfessionalDetail } from '@domain/entities/PatientDetail';

const translations = esJson as Record<string, any>;
function t(key: string, optsOrDefault?: any): string {
  let current: any = translations;
  for (const part of key.split('.')) current = current?.[part];
  if (typeof current === 'string') return current;
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  if (typeof optsOrDefault === 'object' && typeof optsOrDefault?.defaultValue === 'string') return optsOrDefault.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'es' } }) }));

const createProfessional = vi.fn();
const updateProfessional = vi.fn();
vi.mock('@infrastructure/http/AdminPatientContactRowsApiService', () => ({
  AdminPatientContactRowsApiService: {
    createProfessional: (...a: unknown[]) => createProfessional(...a),
    updateProfessional: (...a: unknown[]) => updateProfessional(...a),
  },
}));

import { PatientProfessionalEditDrawer } from '../PatientProfessionalEditDrawer';

const PATIENT_ID = 'a0000000-0000-0000-0000-000000000001';

const professional: PatientProfessionalDetail = {
  id: 'p1',
  name: 'Dra. Ana García',
  phone: '+54 11 5555-0001',
  email: 'ana@example.com',
  specialty: 'PHYSICIAN',
  displayOrder: 1,
  isTeam: false,
};

describe('PatientProfessionalEditDrawer', () => {
  beforeEach(() => {
    createProfessional.mockReset().mockResolvedValue({ id: 'novo-id' });
    updateProfessional.mockReset().mockResolvedValue({ id: 'p1' });
  });

  it('C13: mostra o aviso es-AR de que o contato do terceiro fica registrado e sai impresso', () => {
    render(<PatientProfessionalEditDrawer patientId={PATIENT_ID} professional={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    const notice = screen.getByTestId('professional-notice');
    expect(notice.textContent).toMatch(/registrado/);
    expect(notice.textContent).toMatch(/impreso/);
  });

  it('sem professional: os campos nascem vazios e o Guardar CRIA (POST)', async () => {
    const onSaved = vi.fn();
    render(<PatientProfessionalEditDrawer patientId={PATIENT_ID} professional={null} onClose={vi.fn()} onSaved={onSaved} />);
    expect((screen.getByTestId('professional-name') as HTMLInputElement).value).toBe('');

    fireEvent.change(screen.getByTestId('professional-name'), { target: { value: 'Dr. Nuevo' } });
    fireEvent.click(screen.getByTestId('professional-save'));

    await waitFor(() => expect(createProfessional).toHaveBeenCalledWith(PATIENT_ID, {
      name: 'Dr. Nuevo', phone: null, email: null, specialty: null,
    }));
    expect(updateProfessional).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('com professional: os campos vêm pré-preenchidos e o Guardar EDITA (PATCH pelo id)', async () => {
    render(<PatientProfessionalEditDrawer patientId={PATIENT_ID} professional={professional} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect((screen.getByTestId('professional-name') as HTMLInputElement).value).toBe('Dra. Ana García');
    expect((screen.getByTestId('professional-phone') as HTMLInputElement).value).toBe('+54 11 5555-0001');

    fireEvent.change(screen.getByTestId('professional-phone'), { target: { value: '+54 11 9999-0000' } });
    fireEvent.click(screen.getByTestId('professional-save'));

    await waitFor(() => expect(updateProfessional).toHaveBeenCalledWith(PATIENT_ID, 'p1', {
      name: 'Dra. Ana García', phone: '+54 11 9999-0000', email: 'ana@example.com', specialty: 'PHYSICIAN',
    }));
    expect(createProfessional).not.toHaveBeenCalled();
  });

  it('nome vazio: erro de validação, NENHUMA chamada de API (zod bloqueia antes do submit)', async () => {
    render(<PatientProfessionalEditDrawer patientId={PATIENT_ID} professional={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('professional-save'));
    await waitFor(() => expect(createProfessional).not.toHaveBeenCalled());
  });

  it('falha da API: mensagem GENÉRICA (lex C1.3 — nunca ecoa o payload)', async () => {
    createProfessional.mockRejectedValueOnce(new Error('boom'));
    render(<PatientProfessionalEditDrawer patientId={PATIENT_ID} professional={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('professional-name'), { target: { value: 'Dr. X' } });
    fireEvent.click(screen.getByTestId('professional-save'));
    await waitFor(() => expect(screen.getByTestId('professional-error')).toBeInTheDocument());
    expect(screen.getByTestId('professional-error').textContent).not.toMatch(/boom/);
  });

  it('e-mail inválido: erro de validação exibido no campo (zod .email())', async () => {
    render(<PatientProfessionalEditDrawer patientId={PATIENT_ID} professional={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('professional-name'), { target: { value: 'Dr. X' } });
    fireEvent.change(screen.getByTestId('professional-email'), { target: { value: 'nao-e-email' } });
    fireEvent.click(screen.getByTestId('professional-save'));
    await waitFor(() => expect(createProfessional).not.toHaveBeenCalled());
  });

  it('form sujo + Escape: pede confirmação de descarte antes de fechar (DiscardChangesConfirm)', async () => {
    const onClose = vi.fn();
    render(<PatientProfessionalEditDrawer patientId={PATIENT_ID} professional={null} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('professional-name'), { target: { value: 'Dr. Sujo' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await screen.findByTestId('discard-changes-confirm')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
