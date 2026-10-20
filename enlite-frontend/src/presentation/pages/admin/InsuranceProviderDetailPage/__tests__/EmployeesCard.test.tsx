/** EmployeesCard — Empregados: colunas, Novo/Editar/Retirar, par do documento, e o estado "sem permissão". */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WORKER_DOCUMENT_TYPES } from '@domain/entities/Worker';
import { apiError, comCelulas, contact, semEnforcement } from './support';

vi.mock('react-i18next', async () => (await import('./support')).i18nMock);
const api = vi.hoisted(() => ({ listContacts: vi.fn(), createContact: vi.fn(), patchContact: vi.fn(), retireContact: vi.fn() }));
vi.mock('@infrastructure/http/AdminInsuranceApiService', () => ({ AdminInsuranceApiService: api }));

const { EmployeesCard } = await import('../EmployeesCard');

beforeEach(() => {
  vi.clearAllMocks();
  semEnforcement();
  api.listContacts.mockResolvedValue([contact()]);
});

const change = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });

describe('EmployeesCard', () => {
  it('lista Nome (e-mail embaixo) / Cargo / Telefone / Identificação (tipo + número)', async () => {
    render(<EmployeesCard code="OSDE" />);
    expect(await screen.findByTestId('employee-name-c1')).toHaveTextContent('Pessoa Teste');
    expect(screen.getByTestId('employee-email-c1')).toHaveTextContent('pessoa@exemplo.test');
    expect(screen.getByTestId('employee-role-c1')).toHaveTextContent('Gerente operacional');
    expect(screen.getByTestId('employee-phone-c1')).toHaveTextContent('+54 11 5555-0000');
    expect(screen.getByTestId('employee-document-c1')).toHaveTextContent('CPF');
    expect(screen.getByTestId('employee-document-c1')).toHaveTextContent('000.000.000-00');
  });

  it('o tipo de documento do formulário é exatamente WORKER_DOCUMENT_TYPES (sem lista nova)', async () => {
    render(<EmployeesCard code="OSDE" />);
    await screen.findByTestId('employee-name-c1');
    fireEvent.click(screen.getByTestId('employees-new'));
    const values = Array.from(screen.getByTestId('contact-documentType').querySelectorAll('option')).map((o) => o.getAttribute('value')).filter(Boolean);
    expect(values).toEqual([...WORKER_DOCUMENT_TYPES]);
  });

  it('Novo: só nome, cargo e telefone; opcionais vazios ficam fora do corpo', async () => {
    api.createContact.mockResolvedValue(contact({ id: 'c2' }));
    render(<EmployeesCard code="OSDE" />);
    await screen.findByTestId('employee-name-c1');
    fireEvent.click(screen.getByTestId('employees-new'));
    change('contact-fullName', ' Fulana ');
    change('contact-roleTitle', 'Auditora');
    change('contact-phone', '+54 9 11 0000-1111');
    fireEvent.click(screen.getByTestId('contact-save'));
    await waitFor(() => expect(api.createContact).toHaveBeenCalledWith('OSDE', { fullName: 'Fulana', roleTitle: 'Auditora', phone: '+54 9 11 0000-1111' }));
    await waitFor(() => expect(api.listContacts).toHaveBeenCalledTimes(2));
  });

  it('documento pela metade é recusado na tela, sem chamar a API', async () => {
    render(<EmployeesCard code="OSDE" />);
    await screen.findByTestId('employee-name-c1');
    fireEvent.click(screen.getByTestId('employees-new'));
    change('contact-fullName', 'Fulana');
    change('contact-roleTitle', 'Auditora');
    change('contact-phone', '1');
    change('contact-documentType', 'DNI');
    fireEvent.click(screen.getByTestId('contact-save'));
    expect(screen.getByTestId('contact-problem')).toHaveTextContent('Informe o tipo e o número do documento juntos');
    expect(api.createContact).not.toHaveBeenCalled();
  });

  it('Editar manda só o que mudou; apagar o e-mail manda null', async () => {
    api.patchContact.mockResolvedValue(contact());
    render(<EmployeesCard code="OSDE" />);
    fireEvent.click(await screen.findByTestId('employee-edit-c1'));
    change('contact-roleTitle', 'Diretora');
    change('contact-email', '');
    fireEvent.click(screen.getByTestId('contact-save'));
    await waitFor(() => expect(api.patchContact).toHaveBeenCalledWith('OSDE', 'c1', { roleTitle: 'Diretora', email: null }));
  });

  it('Retirar pede confirmação e chama retire (nunca delete)', async () => {
    api.retireContact.mockResolvedValue(contact({ retired: true }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<EmployeesCard code="OSDE" />);
    fireEvent.click(await screen.findByTestId('employee-retire-c1'));
    await waitFor(() => expect(api.retireContact).toHaveBeenCalledWith('OSDE', 'c1'));
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('erro do back (contato já retirado) vira a frase da tela', async () => {
    api.createContact.mockRejectedValue(apiError(422, 'DOCUMENT_PAIR_INCOMPLETE'));
    render(<EmployeesCard code="OSDE" />);
    await screen.findByTestId('employee-name-c1');
    fireEvent.click(screen.getByTestId('employees-new'));
    change('contact-fullName', 'F');
    change('contact-roleTitle', 'R');
    change('contact-phone', '1');
    fireEvent.click(screen.getByTestId('contact-save'));
    expect(await screen.findByTestId('contact-error')).toHaveTextContent('Informe o tipo e o número do documento, ou nenhum dos dois.');
  });

  it('sem a célula de leitura: estado "sem permissão", nenhuma chamada à API e sem botão Novo', () => {
    comCelulas(['insurance_provider_contacts:create']);
    render(<EmployeesCard code="OSDE" />);
    expect(screen.getByTestId('employees-no-permission')).toBeInTheDocument();
    expect(api.listContacts).not.toHaveBeenCalled();
    expect(screen.queryByTestId('employees-new')).not.toBeInTheDocument();
  });

  it('403 da API também vira "sem permissão" (não uma tabela vazia)', async () => {
    api.listContacts.mockRejectedValue(apiError(403));
    render(<EmployeesCard code="OSDE" />);
    expect(await screen.findByTestId('employees-no-permission')).toBeInTheDocument();
    expect(screen.queryByTestId('employees-empty')).not.toBeInTheDocument();
  });

  it('lista vazia tem mensagem própria', async () => {
    api.listContacts.mockResolvedValue([]);
    render(<EmployeesCard code="OSDE" />);
    expect(await screen.findByTestId('employees-empty')).toBeInTheDocument();
  });
});
