/**
 * Integration tests that render each WorkerDetail card using real pt-BR
 * translations, verifying that user-friendly Portuguese labels appear on screen.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

// ── Build a real t() function from the pt-BR JSON ───────────────────────────

const translations = ptBR as Record<string, any>;

function t(key: string, opts?: any): string {
  const parts = key.split('.');
  let current: any = translations;
  for (const part of parts) {
    current = current?.[part];
  }
  if (typeof current === 'string') return current;
  return opts?.defaultValue ?? key;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { WorkerStatusCard } from '../WorkerStatusCard';
import { WorkerPersonalCard } from '../WorkerPersonalCard';
import { WorkerProfessionalCard } from '../WorkerProfessionalCard';
import { WorkerLocationCard } from '../WorkerLocationCard';
import { WorkerDocumentsCard } from '../WorkerDocumentsCard';
import { WorkerEncuadresCard } from '../WorkerEncuadresCard';
import type { WorkerDocument, WorkerEncuadre } from '@domain/entities/Worker';

const noopAsync = vi.fn().mockResolvedValue(undefined);
const docHandlers = {
  onUpload: noopAsync,
  onDelete: noopAsync,
  onView: noopAsync,
  onValidate: noopAsync,
  onInvalidate: noopAsync,
  loadingTypes: new Set() as Set<any>,
  errors: {},
};

// ── Fixtures ────────────────────────────────────────────────────────────────

const statusProps = {
  status: 'REGISTERED' as const,
  dataSources: ['talentum'],
  platform: 'talentum',
  createdAt: '2026-01-10T00:00:00Z',
  updatedAt: '2026-03-20T00:00:00Z',
};

const personalProps = {
  firstName: 'Ana',
  lastName: 'Silva',
  email: 'ana.silva@test.com',
  phone: '+55 11 99999-0000',
  whatsappPhone: '+55 11 88888-0000',
  profilePhotoUrl: null as string | null,
  birthDate: '1995-06-15',
  documentType: 'CPF',
  documentNumber: '123.456.789-00',
  sex: 'Feminino',
  gender: 'Mulher cis',
};

const professionalProps = {
  profession: 'Psicóloga',
  occupation: 'AT',
  knowledgeLevel: 'Senior',
  titleCertificate: 'CRP 06/12345',
  experienceTypes: ['TEA', 'TDAH'],
  yearsExperience: '5',
  preferredTypes: ['Presencial'],
  preferredAgeRange: ['Adulto'],
  languages: ['Português', 'Inglês'],
  linkedinUrl: 'https://linkedin.com/in/ana-silva',
};

const fullDoc: WorkerDocument = {
  id: 'doc-1',
  resumeCvUrl: 'https://storage.example.com/cv.pdf',
  identityDocumentUrl: 'https://storage.example.com/id.pdf',
  identityDocumentBackUrl: null,
  criminalRecordUrl: null,
  professionalRegistrationUrl: null,
  liabilityInsuranceUrl: null,
  monotributoCertificateUrl: null,
  atCertificateUrl: null,
  additionalCertificatesUrls: [],
  documentsStatus: 'approved',
  reviewNotes: 'Documentos verificados e aprovados.',
  reviewedBy: 'admin-1',
  reviewedAt: '2026-03-15T00:00:00Z',
  submittedAt: '2026-03-10T00:00:00Z',
};

const encuadresFixture: WorkerEncuadre[] = [
  {
    id: 'enc-1',
    jobPostingId: 'jp-100',
    caseNumber: 442,
    patientName: 'Juan Pérez',
    resultado: 'SELECCIONADO',
    interviewDate: '2026-03-10',
    interviewTime: '10:00',
    recruiterName: 'Maria',
    coordinatorName: 'Carlos',
    rejectionReason: null,
    rejectionReasonCategory: null,
    attended: true,
    createdAt: '2026-03-01T00:00:00Z',
  },
];

// ── WorkerStatusCard — pt-BR labels ─────────────────────────────────────────

describe('WorkerStatusCard — pt-BR labels', () => {
  it('renders card title "Status do Prestador"', () => {
    render(<WorkerStatusCard {...statusProps} />);
    expect(screen.getByText('Status do Prestador')).toBeInTheDocument();
  });

  it('renders platform label "Plataforma"', () => {
    render(<WorkerStatusCard {...statusProps} />);
    expect(screen.getByText('Plataforma')).toBeInTheDocument();
  });

  it('renders data sources label "Fontes de dados"', () => {
    render(<WorkerStatusCard {...statusProps} />);
    expect(screen.getByText('Fontes de dados')).toBeInTheDocument();
  });

  it('renders createdAt label "Cadastrado em"', () => {
    render(<WorkerStatusCard {...statusProps} />);
    expect(screen.getByText('Cadastrado em')).toBeInTheDocument();
  });

  it('renders updatedAt label "Atualizado em"', () => {
    render(<WorkerStatusCard {...statusProps} />);
    expect(screen.getByText('Atualizado em')).toBeInTheDocument();
  });

  it('renders status field label "Status"', () => {
    render(<WorkerStatusCard {...statusProps} />);
    expect(screen.getByText('Status')).toBeInTheDocument();
  });
});

// ── WorkerPersonalCard — pt-BR labels ───────────────────────────────────────

describe('WorkerPersonalCard — pt-BR labels', () => {
  it('renders card title "Dados Pessoais"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Dados Pessoais')).toBeInTheDocument();
  });

  it('renders phone label "Telefone"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Telefone')).toBeInTheDocument();
  });

  it('renders birthDate label "Data de nascimento"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Data de nascimento')).toBeInTheDocument();
  });

  it('renders document label "Documento"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Documento')).toBeInTheDocument();
  });

  it('renders sex label "Sexo biológico"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Sexo biológico')).toBeInTheDocument();
  });

  it('renders gender label "Gênero"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Gênero')).toBeInTheDocument();
  });

  it('displays full name "Ana Silva"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Ana Silva')).toBeInTheDocument();
  });

  it('displays email below name', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('ana.silva@test.com')).toBeInTheDocument();
  });

  it('renders WhatsApp label "WhatsApp"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
  });

  it('displays phone and whatsapp values', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('+55 11 99999-0000')).toBeInTheDocument();
    expect(screen.getByText('+55 11 88888-0000')).toBeInTheDocument();
  });

  it('displays formatted birth date', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText(/\/06\/1995/)).toBeInTheDocument();
  });

  it('displays document "CPF: 123.456.789-00"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('CPF: 123.456.789-00')).toBeInTheDocument();
  });
});

// ── WorkerProfessionalCard — pt-BR labels ───────────────────────────────────

describe('WorkerProfessionalCard — pt-BR labels', () => {
  it('renders card title "Dados Profissionais"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Dados Profissionais')).toBeInTheDocument();
  });

  it('renders profession label "Profissão"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Profissão')).toBeInTheDocument();
  });

  it('renders occupation label "Atuação"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Atuação')).toBeInTheDocument();
  });

  it('renders knowledgeLevel label "Nível de Estudos Alcançados"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Nível de Estudos Alcançados')).toBeInTheDocument();
  });

  it('renders titleCertificate label "Título/Certificado"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Título/Certificado')).toBeInTheDocument();
  });

  it('renders yearsExperience label "Anos de experiência"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Anos de experiência')).toBeInTheDocument();
  });

  it('renders preferredAgeRange label "Faixa etária preferida"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Faixa etária preferida')).toBeInTheDocument();
  });

  it('renders experienceTypes label "Tipos de experiência"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Tipos de experiência')).toBeInTheDocument();
  });

  it('renders preferredTypes label "Tipos preferidos"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Tipos preferidos')).toBeInTheDocument();
  });

  it('renders languages label "Idiomas"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Idiomas')).toBeInTheDocument();
  });

  it('renders LinkedIn link with "Ver perfil"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Ver perfil')).toBeInTheDocument();
  });

  it('renders experience type tags', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('TEA')).toBeInTheDocument();
    expect(screen.getByText('TDAH')).toBeInTheDocument();
  });

  it('renders language tags', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Português')).toBeInTheDocument();
    expect(screen.getByText('Inglês')).toBeInTheDocument();
  });
});

// ── WorkerLocationCard — pt-BR labels ───────────────────────────────────────

describe('WorkerLocationCard — pt-BR labels', () => {
  it('renders card title "Localização"', () => {
    render(<WorkerLocationCard serviceAreas={[]} location={null} />);
    expect(screen.getByText('Localização')).toBeInTheDocument();
  });

  it('renders "Nenhuma localização registrada" when empty', () => {
    render(<WorkerLocationCard serviceAreas={[]} location={null} />);
    expect(screen.getByText('Nenhuma localização registrada')).toBeInTheDocument();
  });

  it('renders address label "Endereço"', () => {
    render(
      <WorkerLocationCard
        serviceAreas={[]}
        location={{ address: 'Av. Paulista', city: null, workZone: null, interestZone: null }}
      />,
    );
    expect(screen.getByText('Endereço')).toBeInTheDocument();
  });

  it('renders city label "Cidade"', () => {
    render(
      <WorkerLocationCard
        serviceAreas={[]}
        location={{ address: null, city: 'São Paulo', workZone: null, interestZone: null }}
      />,
    );
    expect(screen.getByText('Cidade')).toBeInTheDocument();
  });

  it('renders workZone label "Zona de trabalho"', () => {
    render(
      <WorkerLocationCard
        serviceAreas={[]}
        location={{ address: null, city: null, workZone: 'Centro', interestZone: null }}
      />,
    );
    expect(screen.getByText('Zona de trabalho')).toBeInTheDocument();
  });

  it('renders interestZone label "Zona de interesse"', () => {
    render(
      <WorkerLocationCard
        serviceAreas={[]}
        location={{ address: null, city: null, workZone: null, interestZone: 'Zona Sul' }}
      />,
    );
    expect(screen.getByText('Zona de interesse')).toBeInTheDocument();
  });

  it('renders service areas title "Áreas de atendimento"', () => {
    render(
      <WorkerLocationCard
        serviceAreas={[{ id: 'sa-1', address: 'Rua X', serviceRadiusKm: 5, lat: null, lng: null }]}
        location={null}
      />,
    );
    expect(screen.getByText('Áreas de atendimento')).toBeInTheDocument();
  });

  it('renders radius label "Raio" with km value', () => {
    render(
      <WorkerLocationCard
        serviceAreas={[{ id: 'sa-1', address: 'Rua X', serviceRadiusKm: 10, lat: null, lng: null }]}
        location={null}
      />,
    );
    expect(screen.getByText(/Raio.*10 km/)).toBeInTheDocument();
  });
});

// ── WorkerDocumentsCard — pt-BR labels ──────────────────────────────────────

describe('WorkerDocumentsCard — pt-BR labels', () => {
  it('renders card title "Documentos"', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Documentos')).toBeInTheDocument();
  });

  it('renders document cards even when documents is null', () => {
    render(<WorkerDocumentsCard documents={null} {...docHandlers} />);
    expect(screen.getByText('Currículo')).toBeInTheDocument();
  });

  it('renders all document labels in pt-BR', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Currículo')).toBeInTheDocument();
    expect(screen.getByText('RG/CPF - Frente')).toBeInTheDocument();
    expect(screen.getByText('Antecedentes penais')).toBeInTheDocument();
    // professional_registration oculto por política ABAC — não deve aparecer
    expect(screen.queryByText('Registro profissional')).not.toBeInTheDocument();
    expect(screen.getByText('Seguro de responsabilidade')).toBeInTheDocument();
  });

  it('renders document type "Currículo"', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Currículo')).toBeInTheDocument();
  });

  it('renders document type "RG/CPF - Frente"', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('RG/CPF - Frente')).toBeInTheDocument();
  });

  it('renders document type "Antecedentes penais"', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Antecedentes penais')).toBeInTheDocument();
  });

  it('does not render "Registro profissional" (oculto por política ABAC)', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.queryByText('Registro profissional')).not.toBeInTheDocument();
  });

  it('renders document type "Seguro de responsabilidade"', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Seguro de responsabilidade')).toBeInTheDocument();
  });

  it('renders view buttons for uploaded documents', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    const viewButtons = screen.getAllByLabelText('Visualizar documento');
    expect(viewButtons.length).toBe(2); // cv + id (criminal is null in fullDoc)
  });

  it('renders review notes label "Notas de revisão"', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Notas de revisão')).toBeInTheDocument();
  });

  it('renders review notes content', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Documentos verificados e aprovados.')).toBeInTheDocument();
  });
});

// ── WorkerEncuadresCard — pt-BR labels ──────────────────────────────────────

describe('WorkerEncuadresCard — pt-BR labels', () => {
  it('renders card title "Encuadres" with count', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Encuadres (1)')).toBeInTheDocument();
  });

  it('renders "Nenhum encuadre registrado" when empty', () => {
    render(<WorkerEncuadresCard encuadres={[]} />);
    expect(screen.getByText('Nenhum encuadre registrado')).toBeInTheDocument();
  });

  it('renders column header "Caso"', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Caso')).toBeInTheDocument();
  });

  it('renders column header "Paciente"', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Paciente')).toBeInTheDocument();
  });

  it('renders column header "Resultado"', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Resultado')).toBeInTheDocument();
  });

  it('renders column header "Entrevista"', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Entrevista')).toBeInTheDocument();
  });

  it('renders column header "Recrutador"', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Recrutador')).toBeInTheDocument();
  });

  it('renders column header "Data"', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Data')).toBeInTheDocument();
  });

  it('renders encuadre data values', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('442')).toBeInTheDocument();
    expect(screen.getByText('Juan Pérez')).toBeInTheDocument();
    expect(screen.getByText('Selecionado')).toBeInTheDocument();
    expect(screen.getByText('Maria')).toBeInTheDocument();
  });
});
