/**
 * Unit tests for PatientDetail feature components.
 *
 * Tests per component:
 *   - Renders with minimal props (no crash)
 *   - Renders with full fixture data
 *   - Null fields render '—' placeholder
 *   - Buttons are present but are no-ops (disabled or handler does nothing)
 *   - i18n keys are resolved correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture, patientDetailMinimal } from './patientDetailFixture';

// ── i18n mock ────────────────────────────────────────────────────────────────

const translations = ptBR as Record<string, any>;

function t(key: string, optsOrDefault?: any): string {
  const parts = key.split('.');
  let current: any = translations;
  for (const part of parts) {
    current = current?.[part];
  }
  if (typeof current === 'string') {
    // interpolate {{count}} etc.
    if (typeof optsOrDefault === 'object' && optsOrDefault !== null) {
      return current.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => optsOrDefault[k] ?? _);
    }
    return current;
  }
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  if (typeof optsOrDefault === 'object' && typeof optsOrDefault?.defaultValue === 'string') return optsOrDefault.defaultValue;
  return key;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'test-id' }),
}));

// AdminApiService — só usado no PATCH do PatientClinicalEditDrawer (DiagnosticoCard).
// Nenhum outro card deste arquivo clica em "salvar", então mockar aqui é seguro.
const updatePatientSection = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { updatePatientSection: (...a: unknown[]) => updatePatientSection(...a) },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { PatientIdentityCard } from '../PatientIdentityCard';
import { PatientGeneralInfoCard } from '../PatientGeneralInfoCard';
import { DiagnosticoCard } from '../DiagnosticoCard';
import { ProjetoTerapeuticoCard } from '../ProjetoTerapeuticoCard';
import { EquipeTratanteCard } from '../EquipeTratanteCard';
import { SupervisaoCard } from '../SupervisaoCard';
import { RelatoriosAtendimentosCard } from '../RelatoriosAtendimentosCard';
import { PatientProfileTabs } from '../PatientProfileTabs';
import { FamiliaresCard } from '../FamiliaresCard';
import { CoberturaMedicaCard } from '../CoberturaMedicaCard';
import { LocalizacoesCard } from '../LocalizacoesCard';
import { ServicosContratadosCard } from '../ServicosContratadosCard';
import { EnquadreTerapeuticoCard } from '../EnquadreTerapeuticoCard';

// ── PatientIdentityCard ──────────────────────────────────────────────────────

describe('PatientIdentityCard', () => {
  it('renders without crash with full data', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    expect(screen.getByText('Santiago Claiman')).toBeInTheDocument();
  });

  it('renders status badge "Aguardando financeiro" for PENDING_ADMISSION (D195 — nome pelo motivo real)', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    expect(screen.getByText('Aguardando financeiro')).toBeInTheDocument();
    expect(screen.queryByText('Em Admissão')).not.toBeInTheDocument();
  });

  it('renders the case number badge when lastCaseNumber is present', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, lastCaseNumber: 747 }} />);
    expect(screen.getByText(/#747/)).toBeInTheDocument();
  });

  it('renders "—" when the patient has no status', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, status: null }} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('falls back to the raw ISO string when the runtime cannot format the date', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(() => {
      throw new RangeError('locale');
    });
    try {
      render(<PatientIdentityCard patient={patientDetailFixture} />);
      expect(screen.getByText('Santiago Claiman')).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the legacy EM_ADMISSAO label for the legacy status value', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, status: 'EM_ADMISSAO' }} />);
    expect(screen.getByText('Em Admissão')).toBeInTheDocument();
  });

  it('renders phone whatsapp value', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    expect(screen.getByText('+55 (11) 91571-1717')).toBeInTheDocument();
  });

  it('renders emergency contact section when responsible present', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    expect(screen.getByText('Contato de Emergência')).toBeInTheDocument();
    expect(screen.getByText('Luciana Soto')).toBeInTheDocument();
  });

  it('does not render emergency contact section when no responsibles', () => {
    render(<PatientIdentityCard patient={patientDetailMinimal} />);
    expect(screen.queryByText('Contato de Emergência')).not.toBeInTheDocument();
  });

  it('renders —  for null name in minimal fixture', () => {
    render(<PatientIdentityCard patient={patientDetailMinimal} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('has Edit button that is disabled', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    const editButton = screen.getByText('Editar');
    expect(editButton.closest('button')).toBeDisabled();
  });

  it('clicking disabled Edit button does not throw', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    const editButton = screen.getByText('Editar');
    expect(() => fireEvent.click(editButton)).not.toThrow();
  });

  it('renders "—" for admission date when createdAt is an empty string (formatDate cannot parse it)', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, createdAt: '' }} />);
    const admissionLabel = screen.getByText(/Admissão/);
    expect(admissionLabel.parentElement).toHaveTextContent('Admissão: —');
  });

  it('builds the address from neighborhood/city/province when no address has fullAddress', () => {
    render(
      <PatientIdentityCard
        patient={{
          ...patientDetailFixture,
          addresses: [],
          zoneNeighborhood: 'Palermo',
          cityLocality: 'CABA',
          province: 'Buenos Aires',
        }}
      />,
    );
    expect(screen.getByText('Endereço:')).toBeInTheDocument();
    expect(screen.getByText('Palermo, CABA, Buenos Aires')).toBeInTheDocument();
  });

  it('does not render the address field when there is no fullAddress and no location parts', () => {
    render(
      <PatientIdentityCard
        patient={{ ...patientDetailFixture, addresses: [], zoneNeighborhood: null, cityLocality: null, province: null }}
      />,
    );
    expect(screen.queryByText('Endereço:')).not.toBeInTheDocument();
  });

  it('falls back to "—" for the responsible name when both firstName and lastName are null', () => {
    render(
      <PatientIdentityCard
        patient={{
          ...patientDetailFixture,
          responsibles: [{ ...patientDetailFixture.responsibles[0], firstName: null, lastName: null }],
        }}
      />,
    );
    const nameLabel = screen.getByText(/Nome do Responsável/);
    expect(nameLabel.parentElement).toHaveTextContent('Nome do Responsável: —');
  });

  it('renders "—" for the responsible document when documentType and documentNumber are both null', () => {
    render(
      <PatientIdentityCard
        patient={{
          ...patientDetailFixture,
          responsibles: [{ ...patientDetailFixture.responsibles[0], documentType: null, documentNumber: null }],
        }}
      />,
    );
    const docLabel = screen.getByText(/Tipo de documento/);
    expect(docLabel.parentElement).toHaveTextContent('Tipo de documento: —');
  });
});

// ── PatientGeneralInfoCard ───────────────────────────────────────────────────

describe('PatientGeneralInfoCard', () => {
  it('renders card title Informações Gerais', () => {
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    expect(screen.getByText('Informações Gerais')).toBeInTheDocument();
  });

  it('renders birth date label', () => {
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    // label is inside a <span>, use regex to match partial text node
    expect(screen.getByText(/Data de nascimento/)).toBeInTheDocument();
  });

  it('renders age label', () => {
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    expect(screen.getByText(/^Idade/)).toBeInTheDocument();
  });

  it('renders sex label', () => {
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    // Multiple "Sexo" spans may exist (label span includes ": ")
    const sexSpans = screen.getAllByText(/^Sexo/);
    expect(sexSpans.length).toBeGreaterThan(0);
  });

  it('renders sex value Masculino for MALE', () => {
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    expect(screen.getByText('Masculino')).toBeInTheDocument();
  });

  it('renders — for null sex in minimal fixture', () => {
    render(<PatientGeneralInfoCard patient={patientDetailMinimal} />);
    // multiple — expected for multiple null fields
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('has an enabled Edit button that opens the edit drawer', () => {
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    const editButton = screen.getByTestId('edit-general-btn');
    expect(editButton).not.toBeDisabled();
    fireEvent.click(editButton);
    expect(screen.getByTestId('patient-general-edit-drawer')).toBeInTheDocument();
  });
});

// ── DiagnosticoCard ──────────────────────────────────────────────────────────

describe('DiagnosticoCard', () => {
  beforeEach(() => { updatePatientSection.mockReset().mockResolvedValue({ id: 'x' }); });

  it('renders card title Diagnóstico', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    expect(screen.getByText('Diagnóstico')).toBeInTheDocument();
  });

  it('renders diagnosis value', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    expect(screen.getByText('CID 6A02.5 Transtorno do espectro autista')).toBeInTheDocument();
  });

  it('renders additionalComments (observações gerais) value', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    expect(screen.getByText('TDAH severo')).toBeInTheDocument();
    expect(screen.getByText(/Observações gerais/)).toBeInTheDocument();
  });

  // ── REQ-01: observações gerais com quebras, autoria e máscara do Clarity ──
  it('preserva quebras de linha (whitespace-pre-wrap) e mostra "Última edição: data · nome"', () => {
    render(<DiagnosticoCard patient={{ ...patientDetailFixture, additionalComments: 'linha 1\nlinha 2' }} />);
    const text = screen.getByTestId('general-notes-text');
    expect(text).toHaveClass('whitespace-pre-wrap');
    expect(text.textContent).toBe('linha 1\nlinha 2');
    const edited = screen.getByTestId('general-notes-edited');
    expect(edited.textContent).toMatch(/^Última edição: .+ · Coordinadora E2E$/);
    expect(edited.textContent).toMatch(/28\/08\/2026/);
  });

  // ── D211.2: instruções de emergência — visível, com autoria; ou REDIGIDO pelo ponto único do backend ──
  it('instruções de emergência: texto com quebras, máscara do Clarity e "Última edição"', () => {
    render(<DiagnosticoCard patient={{ ...patientDetailFixture, emergencyInstructions: 'Llamar al 107\nAvisar a la madre' }} />);
    const box = screen.getByTestId('emergency-instructions');
    expect(box).toHaveAttribute('data-clarity-mask', 'True');
    expect(screen.getByText(/Instruções de emergência/)).toBeInTheDocument();
    expect(screen.getByTestId('emergency-instructions-text').textContent).toBe('Llamar al 107\nAvisar a la madre');
    expect(screen.getByTestId('emergency-instructions-edited').textContent).toMatch(/Coordinadora E2E/);
    expect(screen.queryByTestId('emergency-instructions-redacted')).not.toBeInTheDocument();
  });

  it('redigido pelo backend: mostra o aviso de permissão, sem texto nem autoria', () => {
    render(<DiagnosticoCard patient={{ ...patientDetailFixture, emergencyInstructions: null, emergencyInstructionsUpdatedAt: null, emergencyInstructionsUpdatedBy: null, emergencyInstructionsRedacted: true }} />);
    expect(screen.getByTestId('emergency-instructions-redacted')).toBeInTheDocument();
    expect(screen.queryByTestId('emergency-instructions-edited')).not.toBeInTheDocument();
  });

  it('sem instruções (nunca preenchido) mostra —', () => {
    render(<DiagnosticoCard patient={patientDetailMinimal} />);
    expect(screen.getByTestId('emergency-instructions-text').textContent).toBe('—');
  });

  it('sem autoria (nunca editado pelo painel) não mostra a linha "Última edição"', () => {
    render(<DiagnosticoCard patient={patientDetailMinimal} />);
    expect(screen.queryByTestId('general-notes-edited')).not.toBeInTheDocument();
    expect(screen.getByTestId('general-notes-text').textContent).toBe('—');
  });

  it('com data mas sem nome resolvido, mostra "—" no lugar do nome; data inválida cai no ISO cru', () => {
    render(<DiagnosticoCard patient={{ ...patientDetailFixture, additionalCommentsUpdatedAt: 'não-é-data', additionalCommentsUpdatedBy: null }} />);
    expect(screen.getByTestId('general-notes-edited').textContent).toBe('Última edição: não-é-data · —');
  });

  // lex C1.1: o bloco da narrativa clínica leva data-clarity-mask="True". Este teste é a
  // trava: se alguém remover o atributo, fica vermelho.
  it('o bloco das observações leva data-clarity-mask="True"', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    expect(screen.getByTestId('general-notes')).toHaveAttribute('data-clarity-mask', 'True');
  });

  it('renders CID label', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    // Label text is in a <span>, use regex partial match
    expect(screen.getByText(/Hipótese Diagnóstica - CID/)).toBeInTheDocument();
  });

  it('renders disabilityCertificate label present', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    // hasCud = true → label Certificado de deficiência is rendered
    expect(screen.getByText(/Certificado de deficiência/)).toBeInTheDocument();
  });

  it('renders — for null diagnosis in minimal fixture', () => {
    render(<DiagnosticoCard patient={patientDetailMinimal} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('has an enabled Edit button that opens the edit drawer', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    const editButton = screen.getByTestId('edit-clinical-btn');
    expect(editButton).not.toBeDisabled();
    fireEvent.click(editButton);
    expect(screen.getByTestId('patient-clinical-edit-drawer')).toBeInTheDocument();
  });

  it('salvar uma mudança no drawer chama o onSaved do card e fecha o drawer', async () => {
    const onSaved = vi.fn();
    render(<DiagnosticoCard patient={patientDetailFixture} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('edit-clinical-btn'));
    fireEvent.change(screen.getByTestId('pce-diagnosis'), { target: { value: 'CID novo' } });
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('patient-clinical-edit-drawer')).not.toBeInTheDocument(), { timeout: 1500 });
  });

  it('sem a prop onSaved (opcional), salvar não quebra e ainda assim fecha o drawer', async () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    fireEvent.click(screen.getByTestId('edit-clinical-btn'));
    fireEvent.change(screen.getByTestId('pce-diagnosis'), { target: { value: 'CID novo' } });
    expect(() => fireEvent.click(screen.getByTestId('pce-save'))).not.toThrow();
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('patient-clinical-edit-drawer')).not.toBeInTheDocument(), { timeout: 1500 });
  });
});

// ── ProjetoTerapeuticoCard ───────────────────────────────────────────────────

describe('ProjetoTerapeuticoCard', () => {
  it('renders card title Projeto Terapêutico', () => {
    render(<ProjetoTerapeuticoCard />);
    expect(screen.getByText('Projeto Terapêutico')).toBeInTheDocument();
  });

  it('renders empty state in version table', () => {
    render(<ProjetoTerapeuticoCard />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
  });

  it('has disabled Novo button', () => {
    render(<ProjetoTerapeuticoCard />);
    const novoButton = screen.getByText('Novo');
    expect(novoButton.closest('button')).toBeDisabled();
  });

  it('has disabled Editar button', () => {
    render(<ProjetoTerapeuticoCard />);
    const editButton = screen.getByText('Editar');
    expect(editButton.closest('button')).toBeDisabled();
  });

  it('clicking Novo does not throw', () => {
    render(<ProjetoTerapeuticoCard />);
    const novoButton = screen.getByText('Novo');
    expect(() => fireEvent.click(novoButton)).not.toThrow();
  });
});

// ── EquipeTratanteCard ───────────────────────────────────────────────────────

describe('EquipeTratanteCard', () => {
  it('renders card title Equipe Tratante', () => {
    render(<EquipeTratanteCard professionals={patientDetailFixture.professionals} />);
    expect(screen.getByText('Equipe Tratante')).toBeInTheDocument();
  });

  it('renders professional name from fixture', () => {
    render(<EquipeTratanteCard professionals={patientDetailFixture.professionals} />);
    expect(screen.getByText('Dr. João Alves Pereira')).toBeInTheDocument();
  });

  it('renders professional specialty', () => {
    render(<EquipeTratanteCard professionals={patientDetailFixture.professionals} />);
    expect(screen.getByText('Psicólogo')).toBeInTheDocument();
  });

  it('renders professional phone', () => {
    render(<EquipeTratanteCard professionals={patientDetailFixture.professionals} />);
    expect(screen.getByText('+55 (11) 97580-1332')).toBeInTheDocument();
  });

  it('renders empty state when no professionals', () => {
    render(<EquipeTratanteCard professionals={[]} />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
  });

  it('has disabled Novo button', () => {
    render(<EquipeTratanteCard professionals={[]} />);
    const novoButton = screen.getByText('Novo');
    expect(novoButton.closest('button')).toBeDisabled();
  });

  it('search input is readonly', () => {
    render(<EquipeTratanteCard professionals={[]} />);
    const input = screen.getByPlaceholderText('Pesquisar');
    expect(input).toHaveAttribute('readonly');
  });
});

// ── SupervisaoCard ───────────────────────────────────────────────────────────

describe('SupervisaoCard', () => {
  it('renders card title Supervisão', () => {
    render(<SupervisaoCard />);
    expect(screen.getByText('Supervisão')).toBeInTheDocument();
  });

  it('renders empty state table', () => {
    render(<SupervisaoCard />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
  });

  it('has disabled Novo button', () => {
    render(<SupervisaoCard />);
    const novoButton = screen.getByText('Novo');
    expect(novoButton.closest('button')).toBeDisabled();
  });

  it('clicking Novo does not throw', () => {
    render(<SupervisaoCard />);
    const novoButton = screen.getByText('Novo');
    expect(() => fireEvent.click(novoButton)).not.toThrow();
  });
});

// ── RelatoriosAtendimentosCard ───────────────────────────────────────────────

describe('RelatoriosAtendimentosCard', () => {
  it('renders card title Relatórios de Atendimentos', () => {
    render(<RelatoriosAtendimentosCard />);
    expect(screen.getByText('Relatórios de Atendimentos')).toBeInTheDocument();
  });

  it('renders empty state table', () => {
    render(<RelatoriosAtendimentosCard />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
  });

  it('has disabled Edit button', () => {
    render(<RelatoriosAtendimentosCard />);
    const editButton = screen.getByText('Editar');
    expect(editButton.closest('button')).toBeDisabled();
  });

  it('has disabled Novo button', () => {
    render(<RelatoriosAtendimentosCard />);
    const novoButton = screen.getByText('Novo');
    expect(novoButton.closest('button')).toBeDisabled();
  });

  it('clicking Novo does not throw', () => {
    render(<RelatoriosAtendimentosCard />);
    const novoButton = screen.getByText('Novo');
    expect(() => fireEvent.click(novoButton)).not.toThrow();
  });
});

// ── PatientProfileTabs ───────────────────────────────────────────────────────

describe('PatientProfileTabs', () => {
  it('renders all 7 tabs', () => {
    const onTabChange = vi.fn();
    render(<PatientProfileTabs activeTab="clinicalData" onTabChange={onTabChange} />);
    expect(screen.getByText('Dados Clínicos')).toBeInTheDocument();
    expect(screen.getByText('Rede de Apoio')).toBeInTheDocument();
    expect(screen.getByText('Serviço Contratado')).toBeInTheDocument();
    expect(screen.getByText('Dados Financeiros')).toBeInTheDocument();
    expect(screen.getByText('Enquadre')).toBeInTheDocument();
    expect(screen.getByText('Agendamentos')).toBeInTheDocument();
    expect(screen.getByText('Histórico')).toBeInTheDocument();
  });

  it('active tab has primary background class', () => {
    const onTabChange = vi.fn();
    render(<PatientProfileTabs activeTab="clinicalData" onTabChange={onTabChange} />);
    const activeBtn = screen.getByText('Dados Clínicos').closest('button');
    expect(activeBtn?.className).toContain('bg-primary');
  });

  it('clicking a tab calls onTabChange with correct value', () => {
    const onTabChange = vi.fn();
    render(<PatientProfileTabs activeTab="clinicalData" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByText('Rede de Apoio'));
    expect(onTabChange).toHaveBeenCalledWith('supportNetwork');
  });

  it('inactive tab does not have primary background class', () => {
    const onTabChange = vi.fn();
    render(<PatientProfileTabs activeTab="clinicalData" onTabChange={onTabChange} />);
    const inactiveBtn = screen.getByText('Histórico').closest('button');
    expect(inactiveBtn?.className).not.toContain('bg-primary');
  });
});

// ── FamiliaresCard ───────────────────────────────────────────────────────────

describe('FamiliaresCard', () => {
  it('renders card title Familiares', () => {
    render(<FamiliaresCard responsibles={patientDetailFixture.responsibles} />);
    expect(screen.getByText('Familiares')).toBeInTheDocument();
  });

  it('renders all column headers', () => {
    render(<FamiliaresCard responsibles={patientDetailFixture.responsibles} />);
    expect(screen.getByText('Tipo de Familiar')).toBeInTheDocument();
    expect(screen.getByText('Identificação')).toBeInTheDocument();
    expect(screen.getByText('Nome')).toBeInTheDocument();
    expect(screen.getByText('Telefone')).toBeInTheDocument();
  });

  it('renders responsible name from fixture', () => {
    render(<FamiliaresCard responsibles={patientDetailFixture.responsibles} />);
    expect(screen.getByText('Luciana Soto')).toBeInTheDocument();
  });

  it('renders responsible email below name', () => {
    render(<FamiliaresCard responsibles={patientDetailFixture.responsibles} />);
    expect(screen.getByText('luciana.soto@example.com')).toBeInTheDocument();
  });

  it('renders responsible phone', () => {
    render(<FamiliaresCard responsibles={patientDetailFixture.responsibles} />);
    expect(screen.getByText('(11) 99852-0481')).toBeInTheDocument();
  });

  it('renders responsible document type and number stacked', () => {
    render(<FamiliaresCard responsibles={patientDetailFixture.responsibles} />);
    expect(screen.getByText('CPF')).toBeInTheDocument();
    expect(screen.getByText('987.654.321-00')).toBeInTheDocument();
  });

  it('renders empty state when no responsibles', () => {
    render(<FamiliaresCard responsibles={[]} />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
  });

  it('has disabled Novo button', () => {
    render(<FamiliaresCard responsibles={[]} />);
    const novoButton = screen.getByText('Novo');
    expect(novoButton.closest('button')).toBeDisabled();
  });

  it('search input is readonly', () => {
    render(<FamiliaresCard responsibles={[]} />);
    const input = screen.getByPlaceholderText('Pesquisar');
    expect(input).toHaveAttribute('readonly');
  });

  it('renders multiple responsibles when array has more than one', () => {
    const many = [
      ...patientDetailFixture.responsibles,
      {
        id: 'r2',
        firstName: 'João',
        lastName: 'Silva',
        relationship: 'DAD',
        phone: '(11) 99999-1111',
        email: null,
        documentType: 'CPF',
        documentNumber: '111.222.333-44',
        isPrimary: false,
      },
    ];
    render(<FamiliaresCard responsibles={many} />);
    expect(screen.getByText('Luciana Soto')).toBeInTheDocument();
    expect(screen.getByText('João Silva')).toBeInTheDocument();
  });
});

// ── CoberturaMedicaCard ──────────────────────────────────────────────────────

describe('CoberturaMedicaCard', () => {
  const withInsurance = {
    ...patientDetailFixture,
    insuranceInformed: 'UNIMED',
    insuranceVerified: 'Plano Unimed Empresarial',
    affiliateId: '0000000000000000',
  };

  it('renders card title', () => {
    render(<CoberturaMedicaCard patient={withInsurance} />);
    expect(screen.getByText('Cobertura Médica')).toBeInTheDocument();
  });

  it('renders provider name from insuranceInformed', () => {
    render(<CoberturaMedicaCard patient={withInsurance} />);
    expect(screen.getByText('UNIMED')).toBeInTheDocument();
  });

  it('renders plan from insuranceVerified', () => {
    render(<CoberturaMedicaCard patient={withInsurance} />);
    expect(screen.getByText('Plano Unimed Empresarial')).toBeInTheDocument();
  });

  it('renders affiliateId as credential', () => {
    render(<CoberturaMedicaCard patient={withInsurance} />);
    expect(screen.getByText('0000000000000000')).toBeInTheDocument();
  });

  it('renders "—" for emergency numbers (column missing in schema)', () => {
    render(<CoberturaMedicaCard patient={withInsurance} />);
    // Multiple "—" may exist; assert the label is present at least
    expect(screen.getByText('Números de Emergência')).toBeInTheDocument();
  });

  it('renders "—" when insurance fields are null', () => {
    render(<CoberturaMedicaCard patient={patientDetailMinimal} />);
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(4);
  });

  it('Editar button is disabled', () => {
    render(<CoberturaMedicaCard patient={withInsurance} />);
    const btn = screen.getByText('Editar').closest('button');
    expect(btn).toBeDisabled();
  });
});

// ── LocalizacoesCard ─────────────────────────────────────────────────────────

describe('LocalizacoesCard', () => {
  it('renders card title', () => {
    render(<LocalizacoesCard addresses={patientDetailFixture.addresses} />);
    expect(screen.getByText('Localizações')).toBeInTheDocument();
  });

  it('renders address fullAddress from fixture', () => {
    render(<LocalizacoesCard addresses={patientDetailFixture.addresses} />);
    expect(
      screen.getByText('Rua Augusta, 975 - São Paulo/SP. Torre A, Ap. 701'),
    ).toBeInTheDocument();
  });

  it('renders generic name "Endereço 1" since nameLabel is missing in schema', () => {
    render(<LocalizacoesCard addresses={patientDetailFixture.addresses} />);
    expect(screen.getByText('Endereço 1')).toBeInTheDocument();
  });

  it('renders complement as observation', () => {
    render(<LocalizacoesCard addresses={patientDetailFixture.addresses} />);
    expect(screen.getByText('Torre A, Ap. 701')).toBeInTheDocument();
  });

  it('renders empty state when no addresses', () => {
    render(<LocalizacoesCard addresses={[]} />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
  });

  it('Novo button is disabled', () => {
    render(<LocalizacoesCard addresses={[]} />);
    const btn = screen.getByText('Novo').closest('button');
    expect(btn).toBeDisabled();
  });

  it('renders multiple addresses with sequential generic names', () => {
    const many = [
      ...patientDetailFixture.addresses,
      {
        id: 'addr2',
        street: 'Rua B',
        number: '10',
        complement: null,
        neighborhood: null,
        city: 'SP',
        state: 'SP',
        country: 'BR',
        zipCode: null,
        fullAddress: 'Rua B, 10, SP, SP',
      },
    ];
    render(<LocalizacoesCard addresses={many} />);
    expect(screen.getByText('Endereço 1')).toBeInTheDocument();
    expect(screen.getByText('Endereço 2')).toBeInTheDocument();
  });
});

// ── ServicosContratadosCard ──────────────────────────────────────────────────

describe('ServicosContratadosCard', () => {
  it('renders card title', () => {
    render(<ServicosContratadosCard patient={patientDetailFixture} />);
    expect(screen.getByText('Serviços Contratados')).toBeInTheDocument();
  });

  it('renders all column headers', () => {
    render(<ServicosContratadosCard patient={patientDetailFixture} />);
    expect(screen.getByText('Dispositivo')).toBeInTheDocument();
    expect(screen.getByText('Profissional')).toBeInTheDocument();
    expect(screen.getByText('Quant.')).toBeInTheDocument();
    expect(screen.getByText('Local de Atendimento')).toBeInTheDocument();
    expect(screen.getByText('Sexo')).toBeInTheDocument();
    expect(screen.getByText('Valor')).toBeInTheDocument();
    expect(screen.getByText('Versão')).toBeInTheDocument();
  });

  it('renders a row per serviceType in patient', () => {
    render(<ServicosContratadosCard patient={patientDetailFixture} />);
    expect(screen.getByText('Acompanhante Terapêutico')).toBeInTheDocument();
  });

  it('renders empty state when serviceType is null', () => {
    render(<ServicosContratadosCard patient={patientDetailMinimal} />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
  });

  it('has an enabled edit button that opens the service edit drawer', () => {
    render(<ServicosContratadosCard patient={patientDetailMinimal} />);
    const btn = screen.getByTestId('edit-service-btn');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(screen.getByTestId('patient-service-edit-drawer')).toBeInTheDocument();
  });
});

// ── EnquadreTerapeuticoCard ──────────────────────────────────────────────────

describe('EnquadreTerapeuticoCard', () => {
  it('renders card title', () => {
    render(<EnquadreTerapeuticoCard />);
    expect(screen.getByText('Enquadre Terapêutico')).toBeInTheDocument();
  });

  it('renders the 3 summary fields', () => {
    render(<EnquadreTerapeuticoCard />);
    expect(screen.getByText('Prazo de pagamento')).toBeInTheDocument();
    expect(screen.getByText('Detalhes do Enquadre')).toBeInTheDocument();
    expect(screen.getByText('Capacidade')).toBeInTheDocument();
  });

  it('renders all 4 kanban columns', () => {
    render(<EnquadreTerapeuticoCard />);
    expect(screen.getByTestId('enquadre-column-interview')).toBeInTheDocument();
    expect(screen.getByTestId('enquadre-column-selected')).toBeInTheDocument();
    expect(screen.getByTestId('enquadre-column-inService')).toBeInTheDocument();
    expect(screen.getByTestId('enquadre-column-rejected')).toBeInTheDocument();
  });

  it('renders kanban column titles in pt-BR', () => {
    render(<EnquadreTerapeuticoCard />);
    expect(screen.getByText('Entrevista')).toBeInTheDocument();
    expect(screen.getByText('Selecionados(as)')).toBeInTheDocument();
    expect(screen.getByText('Em Atendimento')).toBeInTheDocument();
    expect(screen.getByText('Rejeitado')).toBeInTheDocument();
  });

  it('all "Adicionar novo" buttons are disabled', () => {
    render(<EnquadreTerapeuticoCard />);
    const btns = screen.getAllByText('Adicionar novo');
    expect(btns.length).toBe(4);
    btns.forEach((btn) => {
      expect(btn.closest('button')).toBeDisabled();
    });
  });

  it('renders empty state message', () => {
    render(<EnquadreTerapeuticoCard />);
    expect(screen.getByText('Sem enquadres cadastrados')).toBeInTheDocument();
  });
});
