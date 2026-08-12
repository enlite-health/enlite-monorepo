/**
 * Integration tests that render each WorkerDetail card using real ES (Spanish)
 * translations, verifying that user-friendly Spanish labels appear on screen.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import es from '@infrastructure/i18n/locales/es.json';

// ── Build a real t() function from the es JSON ──────────────────────────────

const translations = es as Record<string, any>;

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
  dataSources: ['planilla'],
  platform: 'planilla',
  createdAt: '2026-02-01T00:00:00Z',
  updatedAt: '2026-03-25T00:00:00Z',
};

const personalProps = {
  firstName: 'Carlos',
  lastName: 'González',
  email: 'carlos@test.com',
  phone: '+54 11 5555-0000',
  whatsappPhone: '+54 11 4444-0000',
  profilePhotoUrl: 'https://example.com/photo.jpg',
  birthDate: '1990-12-01',
  documentType: 'DNI',
  documentNumber: '30.123.456',
  sex: 'Masculino',
  gender: 'Hombre cis',
};

const professionalProps = {
  profession: 'Psicólogo',
  occupation: 'AT',
  knowledgeLevel: 'Junior',
  titleCertificate: 'MN 12345',
  experienceTypes: ['TEA'],
  yearsExperience: '2',
  preferredTypes: ['Presencial', 'Virtual'],
  preferredAgeRange: ['Niño'],
  languages: ['Español', 'Inglés'],
  linkedinUrl: 'https://linkedin.com/in/carlos-gonzalez',
};

const fullDoc: WorkerDocument = {
  id: 'doc-1',
  resumeCvUrl: 'https://storage.example.com/cv.pdf',
  identityDocumentUrl: null,
  identityDocumentBackUrl: null,
  criminalRecordUrl: 'https://storage.example.com/criminal.pdf',
  professionalRegistrationUrl: null,
  liabilityInsuranceUrl: null,
  monotributoCertificateUrl: null,
  atCertificateUrl: null,
  additionalCertificatesUrls: ['https://storage.example.com/cert.pdf'],
  documentsStatus: 'under_review',
  reviewNotes: 'Pendiente de verificación.',
  reviewedBy: null,
  reviewedAt: null,
  submittedAt: '2026-03-20T00:00:00Z',
};

const encuadresFixture: WorkerEncuadre[] = [
  {
    id: 'enc-1',
    jobPostingId: 'jp-200',
    caseNumber: 100,
    vacancyNumber: 1,
    patientName: 'María López',
    kanbanStage: 'IN_PROGRESS',
    vacancyStatus: 'ACTIVE',
    resultado: 'PENDIENTE',
    interviewDate: '2026-04-01',
    interviewTime: '14:30',
    recruiterName: 'Pedro',
    coordinatorName: 'Laura',
    rejectionReason: null,
    rejectionReasonCategory: null,
    attended: null,
    isBlocked: false,
    blockedReason: null,
    missingFields: [],
    attemptCount: null,
    createdAt: '2026-03-20T00:00:00Z',
  },
];

// ── WorkerStatusCard — es labels ────────────────────────────────────────────

describe('WorkerStatusCard — es labels', () => {
  it('renders card title "Estado del Prestador"', () => {
    render(<WorkerStatusCard {...statusProps} />);
    expect(screen.getByText('Estado del Prestador')).toBeInTheDocument();
  });

  it('renders platform label "Plataforma"', () => {
    render(<WorkerStatusCard {...statusProps} />);
    expect(screen.getByText('Plataforma')).toBeInTheDocument();
  });

  it('renders data sources label "Fuentes de datos"', () => {
    render(<WorkerStatusCard {...statusProps} />);
    expect(screen.getByText('Fuentes de datos')).toBeInTheDocument();
  });

  it('renders createdAt label "Registrado en"', () => {
    render(<WorkerStatusCard {...statusProps} />);
    expect(screen.getByText('Registrado en')).toBeInTheDocument();
  });

  it('renders updatedAt label "Actualizado en"', () => {
    render(<WorkerStatusCard {...statusProps} />);
    expect(screen.getByText('Actualizado en')).toBeInTheDocument();
  });

  it('renders status field label "Estado" (not "Status")', () => {
    render(<WorkerStatusCard {...statusProps} />);
    expect(screen.getByText('Estado')).toBeInTheDocument();
  });

});

// ── WorkerPersonalCard — es labels ──────────────────────────────────────────

describe('WorkerPersonalCard — es labels', () => {
  it('renders card title "Datos Personales"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Datos Personales')).toBeInTheDocument();
  });

  it('renders phone label "Teléfono"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Teléfono')).toBeInTheDocument();
  });

  it('renders birthDate label "Fecha de nacimiento"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Fecha de nacimiento')).toBeInTheDocument();
  });

  it('renders document label "Documento"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Documento')).toBeInTheDocument();
  });

  it('renders sex label "Sexo biológico"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Sexo biológico')).toBeInTheDocument();
  });

  it('renders gender label "Género"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Género')).toBeInTheDocument();
  });

  it('renders WhatsApp label "WhatsApp"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
  });

  it('renders profile photo when URL is provided', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    const img = screen.getByAltText('Carlos González');
    expect(img).toHaveAttribute('src', 'https://example.com/photo.jpg');
  });

  it('displays full name "Carlos González"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('Carlos González')).toBeInTheDocument();
  });

  it('displays document "DNI: 30.123.456"', () => {
    render(<WorkerPersonalCard {...personalProps} />);
    expect(screen.getByText('DNI: 30.123.456')).toBeInTheDocument();
  });
});

// ── WorkerProfessionalCard — es labels ──────────────────────────────────────

describe('WorkerProfessionalCard — es labels', () => {
  it('renders card title "Datos Profesionales"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Datos Profesionales')).toBeInTheDocument();
  });

  it('renders profession label "Profesión"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Profesión')).toBeInTheDocument();
  });

  it('renders occupation label "Ocupación"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Ocupación')).toBeInTheDocument();
  });

  it('renders knowledgeLevel label "Nivel de Estudios Alcanzados"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Nivel de Estudios Alcanzados')).toBeInTheDocument();
  });

  it('renders titleCertificate label "Título/Certificado"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Título/Certificado')).toBeInTheDocument();
  });

  it('renders yearsExperience label "Años de experiencia"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Años de experiencia')).toBeInTheDocument();
  });

  it('renders preferredAgeRange label "Rango etario preferido"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Rango etario preferido')).toBeInTheDocument();
  });

  it('renders experienceTypes label "Tipos de experiencia"', () => {
    render(<WorkerProfessionalCard {...professionalProps} />);
    expect(screen.getByText('Tipos de experiencia')).toBeInTheDocument();
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
});

// ── WorkerLocationCard — es labels ──────────────────────────────────────────

describe('WorkerLocationCard — es labels', () => {
  it('renders card title "Ubicación"', () => {
    render(<WorkerLocationCard serviceAreas={[]} location={null} />);
    expect(screen.getByText('Ubicación')).toBeInTheDocument();
  });

  it('renders "Sin ubicación registrada" when empty', () => {
    render(<WorkerLocationCard serviceAreas={[]} location={null} />);
    expect(screen.getByText('Sin ubicación registrada')).toBeInTheDocument();
  });

  it('renders address label "Dirección"', () => {
    render(
      <WorkerLocationCard
        serviceAreas={[]}
        location={{ address: 'Av. Corrientes', city: null, workZone: null, interestZone: null }}
      />,
    );
    expect(screen.getByText('Dirección')).toBeInTheDocument();
  });

  it('renders city label "Ciudad"', () => {
    render(
      <WorkerLocationCard
        serviceAreas={[]}
        location={{ address: null, city: 'Buenos Aires', workZone: null, interestZone: null }}
      />,
    );
    expect(screen.getByText('Ciudad')).toBeInTheDocument();
  });

  it('renders workZone label "Zona de trabajo"', () => {
    render(
      <WorkerLocationCard
        serviceAreas={[]}
        location={{ address: null, city: null, workZone: 'CABA', interestZone: null }}
      />,
    );
    expect(screen.getByText('Zona de trabajo')).toBeInTheDocument();
  });

  it('renders interestZone label "Zona de interés"', () => {
    render(
      <WorkerLocationCard
        serviceAreas={[]}
        location={{ address: null, city: null, workZone: null, interestZone: 'Zona Norte' }}
      />,
    );
    expect(screen.getByText('Zona de interés')).toBeInTheDocument();
  });

  it('renders service areas title "Áreas de servicio"', () => {
    render(
      <WorkerLocationCard
        serviceAreas={[{ id: 'sa-1', address: 'Calle X', serviceRadiusKm: 5, lat: null, lng: null }]}
        location={null}
      />,
    );
    expect(screen.getByText('Áreas de servicio')).toBeInTheDocument();
  });

  it('renders radius label "Radio" with km value', () => {
    render(
      <WorkerLocationCard
        serviceAreas={[{ id: 'sa-1', address: 'Calle X', serviceRadiusKm: 8, lat: null, lng: null }]}
        location={null}
      />,
    );
    expect(screen.getByText(/Radio.*8 km/)).toBeInTheDocument();
  });
});

// ── WorkerDocumentsCard — es labels ─────────────────────────────────────────

describe('WorkerDocumentsCard — es labels', () => {
  it('renders card title "Documentos"', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Documentos')).toBeInTheDocument();
  });

  it('renders document cards even when documents is null', () => {
    render(<WorkerDocumentsCard documents={null} {...docHandlers} />);
    expect(screen.getByText('Currículum')).toBeInTheDocument();
  });

  it('renders all document labels in es', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Currículum')).toBeInTheDocument();
    expect(screen.getByText('DNI - Frente')).toBeInTheDocument();
    expect(screen.getByText('Antecedentes penales')).toBeInTheDocument();
    // professional_registration oculto por política ABAC — não deve aparecer
    expect(screen.queryByText('Registro profesional')).not.toBeInTheDocument();
    expect(screen.getByText('Seguro de responsabilidad')).toBeInTheDocument();
  });

  it('renders document type "Currículum"', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Currículum')).toBeInTheDocument();
  });

  it('renders document type "DNI - Frente"', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('DNI - Frente')).toBeInTheDocument();
  });

  it('renders document type "Antecedentes penales"', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Antecedentes penales')).toBeInTheDocument();
  });

  it('does not render "Registro profesional" (oculto por política ABAC)', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.queryByText('Registro profesional')).not.toBeInTheDocument();
  });

  it('renders document type "Seguro de responsabilidad"', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Seguro de responsabilidad')).toBeInTheDocument();
  });

  it('renders view buttons for uploaded documents', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    const viewButtons = screen.getAllByLabelText('Visualizar documento');
    expect(viewButtons.length).toBe(2); // cv + criminal (additionalCertificatesUrls moved to AdditionalDocumentsSection)
  });

  // Note: additional certificates are now handled by AdditionalDocumentsSection component
  // and stored in worker_additional_documents table, not in the deprecated TEXT[] array

  it('renders review notes label "Notas de revisión"', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Notas de revisión')).toBeInTheDocument();
  });

  it('renders review notes content', () => {
    render(<WorkerDocumentsCard documents={fullDoc} {...docHandlers} />);
    expect(screen.getByText('Pendiente de verificación.')).toBeInTheDocument();
  });
});

// ── WorkerEncuadresCard — es labels ─────────────────────────────────────────

describe('WorkerEncuadresCard — es labels', () => {
  it('renders card title "Encuadres" with count', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Encuadres (1)')).toBeInTheDocument();
  });

  it('renders "Sin encuadres registrados" when empty', () => {
    render(<WorkerEncuadresCard encuadres={[]} />);
    expect(screen.getByText('Sin encuadres registrados')).toBeInTheDocument();
  });

  it('renders column header "Caso"', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Caso')).toBeInTheDocument();
  });

  it('renders column header "Paciente"', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Paciente')).toBeInTheDocument();
  });

  it('renders column header "Estado"', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Estado')).toBeInTheDocument();
  });

  it('renders column header "Entrevista"', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Entrevista')).toBeInTheDocument();
  });

  it('renders column header "Reclutador"', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Reclutador')).toBeInTheDocument();
  });

  it('renders column header "Fecha"', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('Fecha')).toBeInTheDocument();
  });

  it('renders encuadre data values', () => {
    render(<WorkerEncuadresCard encuadres={encuadresFixture} />);
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('María López')).toBeInTheDocument();
    // status column now shows the Kanban column label, not the encuadre resultado
    expect(screen.getByText('En Progreso')).toBeInTheDocument();
    expect(screen.getByText('Pedro')).toBeInTheDocument();
  });
});
