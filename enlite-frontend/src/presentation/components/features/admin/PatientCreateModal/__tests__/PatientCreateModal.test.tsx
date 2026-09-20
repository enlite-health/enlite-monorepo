/**
 * PatientCreateModal — US-B6 (spec 012): fecha de nacimiento no modal de criação. O payload leva
 * só o que foi preenchido (opcionais vazios viram undefined); erro do backend aparece inline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return cur;
  if (typeof opts === 'string') return opts;
  if (typeof opts === 'object' && typeof opts?.defaultValue === 'string') return opts.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
const createPatient = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({ AdminApiService: { createPatient: (...a: unknown[]) => createPatient(...a) } }));

import { PatientCreateModal } from '../PatientCreateModal';

describe('PatientCreateModal', () => {
  beforeEach(() => createPatient.mockReset().mockResolvedValue({ id: 'new-1' }));

  it('salva nome + fecha de nacimiento; opcionais vazios não vão; onCreated recebe o id', async () => {
    const onCreated = vi.fn();
    render(<PatientCreateModal onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByTestId('pc-firstName'), { target: { value: '  Nina ' } });
    fireEvent.change(screen.getByTestId('pc-country'), { target: { value: 'AR' } });
    const birth = screen.getByTestId('pc-birthDate');
    expect(birth).toHaveAttribute('type', 'date');
    fireEvent.change(birth, { target: { value: '2015-06-20' } });
    fireEvent.change(screen.getByTestId('pc-phone'), { target: { value: '+5491100000031' } });
    fireEvent.click(screen.getByTestId('pc-save'));
    await waitFor(() => expect(createPatient).toHaveBeenCalledWith({
      firstName: 'Nina', country: 'AR', lastName: undefined, birthDate: '2015-06-20', phoneWhatsapp: '+5491100000031', contactEmail: undefined,
      documentType: undefined, documentNumber: undefined, healthInsuranceName: undefined, healthInsuranceMemberId: undefined, serviceType: undefined,
    }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-1'));
  });

  it('tipo de documento e serviço requerido entram quando escolhidos', async () => {
    const { container } = render(<PatientCreateModal onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pc-firstName'), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByTestId('pc-country'), { target: { value: 'AR' } });
    fireEvent.change(screen.getByTestId('pc-documentType'), { target: { value: 'DNI' } });
    fireEvent.click(container.querySelector('#pc-serviceType button') as HTMLElement);
    fireEvent.click(screen.getByText('Cuidador'));
    fireEvent.click(screen.getByTestId('pc-save'));
    await waitFor(() => expect(createPatient).toHaveBeenCalledWith(expect.objectContaining({ documentType: 'DNI', serviceType: ['CAREGIVER'] })));
  });

  it('nome vazio não chama a API; erro com mensagem → inline; erro não-Error → genérica', async () => {
    render(<PatientCreateModal onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('pc-save'));
    await waitFor(() => expect(screen.getByTestId('pc-firstName')).toBeInTheDocument());
    expect(createPatient).not.toHaveBeenCalled();
    createPatient.mockRejectedValueOnce(new Error('Validação de contato'));
    fireEvent.change(screen.getByTestId('pc-firstName'), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByTestId('pc-country'), { target: { value: 'AR' } });
    fireEvent.click(screen.getByTestId('pc-save'));
    expect(await screen.findByTestId('pc-error')).toHaveTextContent('Validação de contato');
    createPatient.mockRejectedValueOnce('x');
    fireEvent.click(screen.getByTestId('pc-save'));
    await waitFor(() => expect(screen.getByTestId('pc-error')).toHaveTextContent('Erro ao criar o paciente'));
  });

  it('Escape e o backdrop fecham (onClose após a transição); outra tecla não', async () => {
    const onClose = vi.fn();
    render(<PatientCreateModal onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1500 });
    fireEvent.click(screen.getByTestId('patient-create-modal-backdrop'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2), { timeout: 1500 });
  });

  it('e-mail inválido: a mensagem de validação aparece e a API não é chamada', async () => {
    render(<PatientCreateModal onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pc-firstName'), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByTestId('pc-country'), { target: { value: 'AR' } });
    fireEvent.change(screen.getByTestId('pc-email'), { target: { value: 'nao-e-email' } });
    fireEvent.click(screen.getByTestId('pc-save'));
    await waitFor(() => expect(screen.getAllByText(/email/i).length).toBeGreaterThan(0));
    expect(createPatient).not.toHaveBeenCalled();
  });
});
