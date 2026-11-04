/** PatientsCard — §L somente leitura: linhas, vazio e 403 com mensagem própria (nenhum deles parece "carregando"). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { apiError, comCelulas, semEnforcement } from './support';

vi.mock('react-i18next', async () => (await import('./support')).i18nMock);
const api = vi.hoisted(() => ({ listProviderPatients: vi.fn() }));
vi.mock('@infrastructure/http/AdminInsuranceApiService', () => ({ AdminInsuranceApiService: api }));

const { PatientsCard } = await import('../PatientsCard');

const row = (over = {}) => ({
  patientId: 'p1', caseNumber: 1234, contractedServiceId: 'abcdef12-0000-0000-0000-000000000000', contractName: 'Contrato Buenos Aires',
  validFrom: '2026-02-01', validTo: null, asOf: '2026-10-19', ...over,
});
const renderCard = () => render(<MemoryRouter><PatientsCard code="OSDE" /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  semEnforcement();
});

describe('PatientsCard', () => {
  it('lista caso (link para a ficha), contrato e vigência, com o asOf da resposta', async () => {
    api.listProviderPatients.mockResolvedValue([row(), row({ patientId: 'p2', caseNumber: null, contractedServiceId: 'zzzz0000-1', validTo: '2026-12-31' })]);
    renderCard();
    const link = await screen.findByTestId('patient-link-abcdef12-0000-0000-0000-000000000000');
    expect(link).toHaveTextContent('Caso 1234');
    expect(link).toHaveAttribute('href', '/admin/patients/p1');
    expect(screen.getByTestId('patient-link-zzzz0000-1')).toHaveTextContent('Sem número de caso');
    expect(screen.getByTestId('patients-as-of')).toHaveTextContent('19/10/2026');
    expect(screen.getAllByText('Contrato Buenos Aires')).toHaveLength(2);
  });

  it('vazio tem mensagem própria', async () => {
    api.listProviderPatients.mockResolvedValue([]);
    renderCard();
    expect(await screen.findByTestId('patients-empty')).toHaveTextContent('Nenhum paciente tem vínculo vigente');
  });

  it('403 da API = "sem permissão" (não vazio)', async () => {
    api.listProviderPatients.mockRejectedValue(apiError(403, 'COUNTRY_SCOPE_REQUIRED'));
    renderCard();
    expect(await screen.findByTestId('patients-no-permission')).toBeInTheDocument();
    expect(screen.queryByTestId('patients-empty')).not.toBeInTheDocument();
  });

  it('sem a célula não chama a API', () => {
    comCelulas(['insurance_contracts:read']);
    renderCard();
    expect(screen.getByTestId('patients-no-permission')).toBeInTheDocument();
    expect(api.listProviderPatients).not.toHaveBeenCalled();
  });

  it('outro erro (500) mostra a frase de erro, não vazio', async () => {
    api.listProviderPatients.mockRejectedValue(apiError(500));
    renderCard();
    expect(await screen.findByTestId('patients-load-error')).toBeInTheDocument();
  });
});
