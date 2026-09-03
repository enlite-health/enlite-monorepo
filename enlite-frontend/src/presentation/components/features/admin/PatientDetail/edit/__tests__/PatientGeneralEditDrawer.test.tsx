/**
 * PatientGeneralEditDrawer — spec 011, A4 (lex C4.3).
 *
 * O drawer carregava `contactEmail: ''` e só enviava o campo se preenchido:
 * o e-mail atual nunca aparecia, e apagá-lo era um no-op silencioso. Agora o
 * valor carrega do detalhe e a comparação é a mesma `!==` dos outros campos:
 * não mexer → não envia; limpar → envia null.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture } from '../../__tests__/patientDetailFixture';

const translations = ptBR as Record<string, any>;
function t(key: string, optsOrDefault?: any): string {
  let current: any = translations;
  for (const part of key.split('.')) current = current?.[part];
  if (typeof current === 'string') return current;
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  if (typeof optsOrDefault === 'object' && typeof optsOrDefault?.defaultValue === 'string') return optsOrDefault.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const updatePatientSection = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { updatePatientSection: (...a: unknown[]) => updatePatientSection(...a) },
}));

import { PatientGeneralEditDrawer } from '../PatientGeneralEditDrawer';

const EMAIL = 'santiago.claiman@example.com';
const patient = { ...patientDetailFixture, contactEmail: EMAIL };

describe('PatientGeneralEditDrawer — e-mail do paciente (A4)', () => {
  beforeEach(() => { updatePatientSection.mockReset().mockResolvedValue({ id: patient.id }); });

  it('carrega o e-mail atual do detalhe no campo (antes carregava vazio)', () => {
    render(<PatientGeneralEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pge-email')).toHaveValue(EMAIL);
  });

  it('(i) editar SÓ o WhatsApp não envia contactEmail — e o e-mail sobrevive no banco', async () => {
    render(<PatientGeneralEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pge-phone'), { target: { value: '+55 11 90000-0000' } });
    fireEvent.click(screen.getByTestId('pge-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'general', { phoneWhatsapp: '+55 11 90000-0000' });
  });

  it('(ii) limpar o e-mail envia null (grava NULL — supressão a pedido do titular)', async () => {
    render(<PatientGeneralEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pge-email'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('pge-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'general', { contactEmail: null });
  });

  it('trocar o e-mail envia o novo valor', async () => {
    render(<PatientGeneralEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pge-email'), { target: { value: 'novo@example.com' } });
    fireEvent.click(screen.getByTestId('pge-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'general', { contactEmail: 'novo@example.com' });
  });

  it('paciente sem e-mail: campo vazio e salvar sem mexer não chama a API', async () => {
    const onClose = vi.fn();
    render(<PatientGeneralEditDrawer patient={{ ...patient, contactEmail: null }} onClose={onClose} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pge-email')).toHaveValue('');
    fireEvent.click(screen.getByTestId('pge-save'));
    await waitFor(() => expect(onClose).not.toHaveBeenCalled());
    expect(updatePatientSection).not.toHaveBeenCalled();
  });
});

// ── Cobertura 100 % do arquivo (D200): cada campo, cada ramo de comparação, fechar, erro ──

import { patientDetailMinimal } from '../../__tests__/patientDetailFixture';

describe('PatientGeneralEditDrawer — todos os campos e ramos', () => {
  beforeEach(() => { updatePatientSection.mockReset().mockResolvedValue({ id: patient.id }); });

  it('paciente sem dados: todos os campos carregam vazios', () => {
    render(<PatientGeneralEditDrawer patient={patientDetailMinimal} onClose={vi.fn()} onSaved={vi.fn()} />);
    for (const id of ['pge-firstName', 'pge-lastName', 'pge-phone', 'pge-email', 'pge-documentNumber', 'pge-birthDate']) {
      expect(screen.getByTestId(id)).toHaveValue('');
    }
    expect(screen.getByTestId('pge-documentType')).toHaveValue('');
    expect(screen.getByTestId('pge-sex')).toHaveValue('');
  });

  it('sem mudança nenhuma: não chama a API e fecha', async () => {
    const onClose = vi.fn();
    render(<PatientGeneralEditDrawer patient={patient} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('pge-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 });
    expect(updatePatientSection).not.toHaveBeenCalled();
  });

  it('cada campo alterado vai sozinho no payload; limpar manda null', async () => {
    render(<PatientGeneralEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pge-firstName'), { target: { value: 'Santi' } });
    fireEvent.change(screen.getByTestId('pge-lastName'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('pge-documentType'), { target: { value: 'DNI' } });
    fireEvent.change(screen.getByTestId('pge-documentNumber'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('pge-sex'), { target: { value: 'FEMALE' } });
    fireEvent.change(screen.getByTestId('pge-birthDate'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('pge-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'general', {
      firstName: 'Santi', lastName: null, documentType: 'DNI', documentNumber: null, sex: 'FEMALE', birthDate: null,
    });
  });

  it('paciente sem dados: preencher cada campo manda o valor', async () => {
    render(<PatientGeneralEditDrawer patient={patientDetailMinimal} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pge-firstName'), { target: { value: 'Nuevo' } });
    fireEvent.change(screen.getByTestId('pge-lastName'), { target: { value: 'Apellido' } });
    fireEvent.change(screen.getByTestId('pge-phone'), { target: { value: '+54 11 1' } });
    fireEvent.change(screen.getByTestId('pge-documentNumber'), { target: { value: '123' } });
    fireEvent.change(screen.getByTestId('pge-birthDate'), { target: { value: '2000-01-02' } });
    fireEvent.click(screen.getByTestId('pge-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    expect(updatePatientSection).toHaveBeenCalledWith(patientDetailMinimal.id, 'general', {
      firstName: 'Nuevo', lastName: 'Apellido', phoneWhatsapp: '+54 11 1', documentNumber: '123', birthDate: '2000-01-02',
    });
  });

  it('nome vazio e e-mail inválido: erros de validação na tela, sem chamar a API', async () => {
    render(<PatientGeneralEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pge-firstName'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('pge-email'), { target: { value: 'nao-e-email' } });
    fireEvent.click(screen.getByTestId('pge-save'));
    await screen.findAllByText(/Invalid email/);
    expect(await screen.findByText(/at least 1 character/)).toBeInTheDocument();
    expect(updatePatientSection).not.toHaveBeenCalled();
  });

  it('erro da API: Error mostra a mensagem; erro que não é Error mostra a genérica', async () => {
    updatePatientSection.mockRejectedValueOnce(new Error('falhou de verdade'));
    const { unmount } = render(<PatientGeneralEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pge-phone'), { target: { value: '+1' } });
    fireEvent.click(screen.getByTestId('pge-save'));
    expect(await screen.findByText('falhou de verdade')).toBeInTheDocument();
    unmount();
    updatePatientSection.mockRejectedValueOnce('string crua');
    render(<PatientGeneralEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pge-phone'), { target: { value: '+2' } });
    fireEvent.click(screen.getByTestId('pge-save'));
    expect(await screen.findByText('Erro ao salvar')).toBeInTheDocument();
  });

  it('Escape e clique no backdrop fecham o drawer', async () => {
    const onClose = vi.fn();
    render(<PatientGeneralEditDrawer patient={patient} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 2000 });
    fireEvent.click(screen.getByTestId('patient-general-edit-backdrop'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2), { timeout: 2000 });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

// ── QA caça 🟡3 (spec 011, rodada 2): data de nascimento ausente não vira PATCH fantasma ──

describe('PatientGeneralEditDrawer — data de nascimento', () => {
  beforeEach(() => { updatePatientSection.mockReset().mockResolvedValue({ id: patient.id }); });

  it('paciente SEM data: Guardar sem mexer → 0 chamadas (antes mandava birthDate:null e bumpava updated_at)', async () => {
    const onClose = vi.fn();
    render(<PatientGeneralEditDrawer patient={{ ...patient, birthDate: null }} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('pge-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 });
    expect(updatePatientSection).not.toHaveBeenCalled();
  });

  it('controle positivo — paciente COM data: Guardar sem mexer → 0 chamadas', async () => {
    const onClose = vi.fn();
    render(<PatientGeneralEditDrawer patient={patient} onClose={onClose} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pge-birthDate')).toHaveValue('1960-03-18');
    fireEvent.click(screen.getByTestId('pge-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 });
    expect(updatePatientSection).not.toHaveBeenCalled();
  });

  it('mudar a data → 1 chamada só com birthDate', async () => {
    render(<PatientGeneralEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pge-birthDate'), { target: { value: '1961-04-19' } });
    fireEvent.click(screen.getByTestId('pge-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'general', { birthDate: '1961-04-19' });
  });
});
