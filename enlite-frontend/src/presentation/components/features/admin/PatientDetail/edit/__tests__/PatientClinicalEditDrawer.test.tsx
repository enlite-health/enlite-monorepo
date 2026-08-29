/**
 * PatientClinicalEditDrawer — REQ-01 (D195): "observações gerais" em textarea grande,
 * com contador e máscara do Clarity; o PATCH manda só o que mudou.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture, patientDetailMinimal } from '../../__tests__/patientDetailFixture';

const translations = ptBR as Record<string, any>;
function t(key: string, optsOrDefault?: any): string {
  let current: any = translations;
  for (const part of key.split('.')) current = current?.[part];
  if (typeof current === 'string') {
    if (typeof optsOrDefault === 'object' && optsOrDefault !== null) {
      return current.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => optsOrDefault[k] ?? _);
    }
    return current;
  }
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  if (typeof optsOrDefault === 'object' && typeof optsOrDefault?.defaultValue === 'string') return optsOrDefault.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const updatePatientSection = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { updatePatientSection: (...a: unknown[]) => updatePatientSection(...a) },
}));

import { PatientClinicalEditDrawer, GENERAL_NOTES_MAX } from '../PatientClinicalEditDrawer';

describe('PatientClinicalEditDrawer — observações gerais (REQ-01)', () => {
  beforeEach(() => { updatePatientSection.mockReset().mockResolvedValue({ id: 'x' }); });

  it('renderiza um TEXTAREA (não input de uma linha) com 8 linhas, teto e valor atual', () => {
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    const ta = screen.getByTestId('pce-comments');
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta).toHaveAttribute('rows', '8');
    expect(ta).toHaveAttribute('maxlength', String(GENERAL_NOTES_MAX));
    expect(ta).toHaveValue('TDAH severo');
    expect(screen.getByText(/Observações gerais/)).toBeInTheDocument();
  });

  it('contador acompanha o que é digitado', () => {
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pce-comments-counter').textContent).toBe(`11/${GENERAL_NOTES_MAX} caracteres`);
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'linha 1\nlinha 2' } });
    expect(screen.getByTestId('pce-comments-counter').textContent).toBe(`15/${GENERAL_NOTES_MAX} caracteres`);
  });

  // lex C1.1 — trava: remover o atributo deixa este teste vermelho.
  it('o wrapper do textarea leva data-clarity-mask="True"', () => {
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pce-comments').parentElement).toHaveAttribute('data-clarity-mask', 'True');
  });

  it('salvar manda SÓ o campo alterado, com as quebras de linha, e chama onSaved', async () => {
    const onSaved = vi.fn();
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'Crisis: llamar a la madre.\nEvitar ruidos.' } });
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    expect(updatePatientSection).toHaveBeenCalledWith(patientDetailFixture.id, 'clinical', {
      additionalComments: 'Crisis: llamar a la madre.\nEvitar ruidos.',
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('apagar o texto manda null (limpar é uma edição)', async () => {
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patientDetailFixture.id, 'clinical', { additionalComments: null }));
  });

  it('sem mudança não chama a API e fecha', async () => {
    const onClose = vi.fn();
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1500 });
    expect(updatePatientSection).not.toHaveBeenCalled();
  });

  it('erro da API aparece na tela sem o texto clínico no erro exibido vindo da mensagem genérica', async () => {
    updatePatientSection.mockRejectedValueOnce(new Error('Failed to update patient section'));
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'novo' } });
    fireEvent.click(screen.getByTestId('pce-save'));
    expect(await screen.findByText('Failed to update patient section')).toBeInTheDocument();
  });

  it('erro sem instância de Error cai no fallback traduzido (saveError)', async () => {
    updatePatientSection.mockRejectedValueOnce('boom, não é Error');
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'novo' } });
    fireEvent.click(screen.getByTestId('pce-save'));
    expect(await screen.findByText('Erro ao salvar')).toBeInTheDocument();
  });

  it('Escape fecha o drawer (chama onClose após a transição)', async () => {
    const onClose = vi.fn();
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1500 });
  });

  it('tecla diferente de Escape não fecha o drawer', () => {
    const onClose = vi.fn();
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('altera diagnóstico, dispositivo, dependência, especialidade, tipo de serviço e os 3 selects tri-state — manda tudo no payload', async () => {
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByTestId('pce-diagnosis'), { target: { value: 'CID novo' } });
    fireEvent.change(screen.getByTestId('pce-device'), { target: { value: 'Cadeira de rodas' } });
    fireEvent.change(screen.getByTestId('pce-dependency'), { target: { value: 'MODERATE' } });
    fireEvent.change(screen.getByTestId('pce-specialty'), { target: { value: 'GERIATRIC' } });
    // hasJudicialProtection: false → true (strToBool 'true')
    fireEvent.change(screen.getByTestId('pce-hasJudicialProtection'), { target: { value: 'true' } });
    // hasCud: true → false (strToBool 'false')
    fireEvent.change(screen.getByTestId('pce-hasCud'), { target: { value: 'false' } });
    // hasConsent: true → '' (tri-state "unset", strToBool cai no branch `return null` — linhas 56-57)
    fireEvent.change(screen.getByTestId('pce-hasConsent'), { target: { value: '' } });
    // serviceType: ['AT'] → ['AT', 'CAREGIVER'] via MultiSelect (abre pelo botão com o valor atual)
    fireEvent.click(screen.getByText('Acompanhante Terapêutico'));
    fireEvent.click(screen.getByText('Cuidador'));

    fireEvent.click(screen.getByTestId('pce-save'));

    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    expect(updatePatientSection).toHaveBeenCalledWith(patientDetailFixture.id, 'clinical', {
      diagnosis: 'CID novo',
      deviceType: 'Cadeira de rodas',
      dependencyLevel: 'MODERATE',
      clinicalSpecialty: 'GERIATRIC',
      serviceType: ['AT', 'CAREGIVER'],
      hasJudicialProtection: true,
      hasCud: false,
      hasConsent: null,
    });
  });

  it('paciente mínimo (todos os campos vazios/null): sem mudança não chama a API — cobre os defaults `?? null`/`?? []`/boolToStr(null)', async () => {
    const onClose = vi.fn();
    render(<PatientClinicalEditDrawer patient={patientDetailMinimal} onClose={onClose} onSaved={vi.fn()} />);
    // os 3 tri-state ficam '' (unset) por default — confirma antes de salvar
    expect(screen.getByTestId('pce-hasJudicialProtection')).toHaveValue('');
    expect(screen.getByTestId('pce-hasCud')).toHaveValue('');
    expect(screen.getByTestId('pce-hasConsent')).toHaveValue('');
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1500 });
    expect(updatePatientSection).not.toHaveBeenCalled();
  });
});
