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

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('renders status badge Em Admissão', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
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

  it('has Edit button that is disabled', () => {
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    const editButton = screen.getByText('Editar');
    expect(editButton.closest('button')).toBeDisabled();
  });
});

// ── DiagnosticoCard ──────────────────────────────────────────────────────────

describe('DiagnosticoCard', () => {
  it('renders card title Diagnóstico', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    expect(screen.getByText('Diagnóstico')).toBeInTheDocument();
  });

  it('renders diagnosis value', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    expect(screen.getByText('CID 6A02.5 Transtorno do espectro autista')).toBeInTheDocument();
  });

  it('renders additionalComments (details) value', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    expect(screen.getByText('TDAH severo')).toBeInTheDocument();
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

  it('has Edit button that is disabled', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    const editButton = screen.getByText('Editar');
    expect(editButton.closest('button')).toBeDisabled();
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
    healthInsurance: {
      providerName: 'UNIMED',
      plan: 'Plano Unimed Empresarial',
      memberId: '0000000000000000',
      emergencyNumbers: ['0800-123-4567', '0800-765-4321'],
      source: 'manual' as const,
    },
  };

  it('renders card title', () => {
    render(<CoberturaMedicaCard patient={withInsurance} />);
    expect(screen.getByText('Cobertura Médica')).toBeInTheDocument();
  });

  it('renders provider name from healthInsurance.providerName', () => {
    render(<CoberturaMedicaCard patient={withInsurance} />);
    expect(screen.getByText('UNIMED')).toBeInTheDocument();
  });

  it('renders plan from healthInsurance.plan', () => {
    render(<CoberturaMedicaCard patient={withInsurance} />);
    expect(screen.getByText('Plano Unimed Empresarial')).toBeInTheDocument();
  });

  it('renders memberId as credential', () => {
    render(<CoberturaMedicaCard patient={withInsurance} />);
    expect(screen.getByText('0000000000000000')).toBeInTheDocument();
  });

  it('renders emergency numbers joined by comma', () => {
    render(<CoberturaMedicaCard patient={withInsurance} />);
    expect(screen.getByText('0800-123-4567, 0800-765-4321')).toBeInTheDocument();
  });

  it('renders "—" for emergency numbers when array is empty', () => {
    const noEmergency = {
      ...withInsurance,
      healthInsurance: { ...withInsurance.healthInsurance, emergencyNumbers: [] },
    };
    render(<CoberturaMedicaCard patient={noEmergency} />);
    expect(screen.getByText('Números de Emergência')).toBeInTheDocument();
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('renders fixture healthInsurance data (OSDE / Plan 410)', () => {
    render(<CoberturaMedicaCard patient={patientDetailFixture} />);
    expect(screen.getByText('OSDE')).toBeInTheDocument();
    expect(screen.getByText('Plan 410')).toBeInTheDocument();
    expect(screen.getByText('12345678')).toBeInTheDocument();
    expect(screen.getByText('0800-555-1234')).toBeInTheDocument();
  });

  it('renders "—" for all fields when healthInsurance is null', () => {
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

  it('renders addressFormatted from fixture', () => {
    render(<LocalizacoesCard addresses={patientDetailFixture.addresses} />);
    expect(
      screen.getByText('Rua Augusta, 975 - São Paulo/SP'),
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
        addressType: 'secondary',
        addressFormatted: 'Rua B, 10, SP, SP',
        addressRaw: 'Rua B, 10',
        complement: null,
        displayOrder: 2,
        isPrimary: false,
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

  it('Novo button is disabled', () => {
    render(<ServicosContratadosCard patient={patientDetailMinimal} />);
    const btn = screen.getByText('Novo').closest('button');
    expect(btn).toBeDisabled();
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
