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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture, patientDetailMinimal } from './patientDetailFixture';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

// ── AdminPatientContactRowsApiService mock ────────────────────────────────────────────────────
// Um SÓ vi.mock por módulo (o 2º registro pisava no 1º em silêncio — `vi.mock` não funde objetos
// de chamadas repetidas para o mesmo caminho, substitui): EquipeTratanteCard — deactivate flow
// (spec 018 PR-5) + EmergencyMarkButton (FamiliaresCard/ExternalContactsCard, spec 018 PR-2).
const mockDeactivateProfessional = vi.fn();
const mockCreateProfessional = vi.fn();
const mockUpdateProfessional = vi.fn();
const markEmergencyContact = vi.fn().mockResolvedValue({});
const unmarkEmergencyContact = vi.fn().mockResolvedValue({});
vi.mock('@infrastructure/http/AdminPatientContactRowsApiService', () => ({
  AdminPatientContactRowsApiService: {
    deactivateProfessional: (...a: unknown[]) => mockDeactivateProfessional(...a),
    createProfessional: (...a: unknown[]) => mockCreateProfessional(...a),
    updateProfessional: (...a: unknown[]) => mockUpdateProfessional(...a),
    markEmergencyContact: (...a: unknown[]) => markEmergencyContact(...a),
    unmarkEmergencyContact: (...a: unknown[]) => unmarkEmergencyContact(...a),
  },
}));

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
  useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'test-id' }),
}));

// AdminApiService — só usado no PATCH do PatientClinicalEditDrawer (DiagnosticoCard).
// Nenhum outro card deste arquivo clica em "salvar", então mockar aqui é seguro.
const updatePatientSection = vi.fn();
// Spec 012: o drawer de cobertura lê o catálogo ao abrir (cai no seed dos 33 se falhar).
const listInsuranceProviders = vi.fn().mockResolvedValue([]);
// Spec 019 (US 4.2): ação inline "Marcar como principal" do LocalizacoesCard.
const updatePatientAddressLogistics = vi.fn().mockResolvedValue({ id: 'addr1' });
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    updatePatientSection: (...a: unknown[]) => updatePatientSection(...a),
    listInsuranceProviders: (...a: unknown[]) => listInsuranceProviders(...a),
    updatePatientAddressLogistics: (...a: unknown[]) => updatePatientAddressLogistics(...a),
  },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { PatientIdentityCard } from '../PatientIdentityCard';
import { PatientGeneralInfoCard } from '../PatientGeneralInfoCard';
import { DiagnosticoCard } from '../DiagnosticoCard';
import { EquipeTratanteCard } from '../EquipeTratanteCard';
import { SupervisaoCard } from '../SupervisaoCard';
import { RelatoriosAtendimentosCard } from '../RelatoriosAtendimentosCard';
import { PatientProfileTabs } from '../PatientProfileTabs';
import { FamiliaresCard } from '../FamiliaresCard';
import { CoberturaMedicaCard } from '../CoberturaMedicaCard';
import { LocalizacoesCard } from '../LocalizacoesCard';
import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';

// ── PatientIdentityCard ──────────────────────────────────────────────────────

describe('PatientIdentityCard', () => {
  // 06/09: o nome subiu para o `h1` da PÁGINA — o cartão não o repete mais. A âncora aqui passa a
  // ser o telefone, que é dado dele.
  it('renders without crash with full data', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    expect(screen.getByTestId('patient-identity-card')).toBeInTheDocument();
    expect(screen.getByText('+55 (11) 91571-1717')).toBeInTheDocument();
    expect(screen.queryByText('Santiago Claiman')).not.toBeInTheDocument();
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
      expect(screen.getByTestId('patient-identity-card')).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('status fora do vocabulário v2 cai no valor cru (fallback do i18n), nunca em branco', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, status: 'EM_ADMISSAO' }} />);
    expect(screen.getByTestId('patient-status-badge')).toHaveTextContent('EM_ADMISSAO');
  });

  it('spec 012 US-B7: ON_HOLD mostra o estado v2 traduzido + o motivo da espera (rótulo, nunca a nota)', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, status: 'ON_HOLD', admissionStatus: 'DONE', onHoldReason: 'INSURER', onHoldNote: 'nota clinica 7c2a' }} />);
    expect(screen.getByTestId('patient-status-badge')).toHaveTextContent('Em espera');
    expect(screen.getByTestId('patient-on-hold-reason')).toHaveTextContent('Convênio / obra social');
    expect(screen.queryByText(/7c2a/)).not.toBeInTheDocument();
    // sem motivo → sem badge de motivo
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, status: 'ON_HOLD', onHoldReason: null }} />);
    expect(screen.getAllByTestId('patient-on-hold-reason')).toHaveLength(1);
  });

  it('renders phone whatsapp value', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    expect(screen.getByText('+55 (11) 91571-1717')).toBeInTheDocument();
  });

  // Spec 018 PR-3 (FR-208/210/224, US-8, D-A): o bloco mostra o contato MARCADO
  // (`emergencyContactRef`), nunca mais `find(isPrimary) ?? responsibles[0]` — a fixture aponta a
  // marca para 'r1' (Luciana Soto). Documento vem MASCARADO (FR-210, `lex` #3(b)).
  it('spec 018 PR-3: mostra o contato de emergência MARCADO, com documento mascarado', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    expect(screen.getByText('Contato de Emergência:')).toBeInTheDocument();
    expect(screen.getByTestId('emergency-contact-name')).toHaveTextContent('Luciana Soto');
    expect(screen.getByTestId('emergency-contact-phone')).toHaveTextContent('(11) 99852-0481');
    const doc = screen.getByTestId('emergency-contact-document-number');
    expect(doc.textContent).not.toContain('987.654.321-00');
    // últimos 3 caracteres ALFANUMÉRICOS visíveis (maskDocumentNumber): de "987654321 00" os
    // últimos 3 são '1','0','0' — o '-' original é preservado na posição.
    expect(doc).toHaveTextContent('1-00');
    expect(doc.textContent).toMatch(/^•+.*1-00$/);
  });

  // FR-224 (3 estados sem fallback): sem marca definida (célula presente, `emergencyContactRef:
  // null`) → "não definido" — nunca um fallback pro primeiro/principal responsável da lista.
  it('spec 018 PR-3 FR-224: sem marca definida mostra "Não definido", nunca um fallback pro primeiro responsável', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, emergencyContactRef: null }} />);
    expect(screen.getByTestId('emergency-contact-not-set')).toHaveTextContent('Não definido');
    expect(screen.queryByTestId('emergency-contact-name')).not.toBeInTheDocument();
    expect(screen.queryByText('Luciana Soto')).not.toBeInTheDocument();
  });

  // D113/lex C3: sem `patient_family:read`, os 4 campos do container saem `null` juntos —
  // `externalContacts === null` é o sinal (mesmo já documentado no domínio); marcador CONSTANTE,
  // não depende de haver ou não marca.
  it('spec 018 PR-3 CONDIÇÃO 5/lex C3: sem patient_family:read (externalContacts null) mostra o marcador de redação', () => {
    render(
      <PatientIdentityCard
        patient={{ ...patientDetailFixture, externalContacts: null, emergencyContactRef: null, responsibles: [] }}
      />,
    );
    expect(screen.getByTestId('emergency-contact-redacted')).toBeInTheDocument();
    expect(screen.queryByTestId('emergency-contact-not-set')).not.toBeInTheDocument();
    expect(screen.queryByText('Luciana Soto')).not.toBeInTheDocument();
  });

  // L3a (checklist lex.md): a variante FORTE do teste acima — `responsibles` vem PREENCHIDO (o
  // paciente TEM familiares cadastrados), e mesmo assim, sem `patient_family:read`, nenhum nome
  // aparece. `responsibles: []` sozinho não provava nada: um card vazio nunca cairia no fallback
  // `find(isPrimary) ?? responsibles[0]` de qualquer jeito (não há `[0]`). Só com a lista cheia é
  // que a ausência do nome prova que o fallback (`PatientIdentityCard.tsx` antigo, linhas 167-168,
  // já removido) não foi reintroduzido.
  it('spec 018 PR-3 L3a: sem patient_family:read, MESMO com responsibles preenchido e SEM marca, nenhum nome aparece — nunca o fallback pro primeiro responsável', () => {
    render(
      <PatientIdentityCard
        patient={{ ...patientDetailFixture, externalContacts: null, emergencyContactRef: null }}
        // `responsibles` fica com o valor DEFAULT da fixture (não-vazio: contém "Luciana Soto").
      />,
    );
    expect(screen.getByTestId('emergency-contact-redacted')).toBeInTheDocument();
    expect(screen.queryByTestId('emergency-contact-name')).not.toBeInTheDocument();
    expect(screen.queryByText('Luciana Soto')).not.toBeInTheDocument();
    expect(screen.queryByText(/99852-0481/)).not.toBeInTheDocument();
    const bloco = screen.getByTestId('patient-emergency-contact-section');
    expect(bloco.innerHTML).not.toContain('Luciana');
    expect(bloco.innerHTML).not.toContain('99852-0481');
  });

  // D-A #6: contato externo marcado — rótulos "do contato", SEM par de documento (a coluna não existe).
  it('spec 018 PR-3 D-A #6: marca em contato EXTERNO usa rótulos "do contato" e não mostra documento', () => {
    render(
      <PatientIdentityCard
        patient={{
          ...patientDetailFixture,
          externalContacts: [{ id: 'ext1', relation: 'TEACHER', name: 'Marcela Souza', phone: '(11) 90000-1111', active: true }],
          emergencyContactRef: { kind: 'EXTERNAL', id: 'ext1' },
        }}
      />,
    );
    expect(screen.getByTestId('emergency-contact-name')).toHaveTextContent('Marcela Souza');
    expect(screen.getByTestId('emergency-contact-phone')).toHaveTextContent('90000-1111');
    expect(screen.queryByTestId('emergency-contact-document-number')).not.toBeInTheDocument();
  });

  // marca órfã (ex.: id não bate mais com nenhum responsável/contato vivo) nunca quebra a tela —
  // cai em "não definido", o mesmo estado de "sem marca". Os DOIS `kind` (RESPONSIBLE/EXTERNAL).
  it('marca apontando para id inexistente não quebra a tela — cai em "não definido"', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, emergencyContactRef: { kind: 'RESPONSIBLE', id: 'orfao' } }} />);
    expect(screen.getByTestId('emergency-contact-not-set')).toBeInTheDocument();
  });

  it('marca em contato EXTERNO com nome vazio (defensivo) mostra "—", nunca string vazia', () => {
    render(
      <PatientIdentityCard
        patient={{
          ...patientDetailFixture,
          externalContacts: [{ id: 'ext2', relation: 'NEIGHBOR', name: '', phone: '(11) 91111-2222', active: true }],
          emergencyContactRef: { kind: 'EXTERNAL', id: 'ext2' },
        }}
      />,
    );
    expect(screen.getByTestId('emergency-contact-name')).toHaveTextContent('—');
  });

  it('marca EXTERNAL órfã (id não bate com nenhum contato externo) também cai em "não definido"', () => {
    render(
      <PatientIdentityCard
        patient={{ ...patientDetailFixture, externalContacts: [], emergencyContactRef: { kind: 'EXTERNAL', id: 'orfao' } }}
      />,
    );
    expect(screen.getByTestId('emergency-contact-not-set')).toBeInTheDocument();
  });

  // FR-211 (lex #3(c)): `data-clarity-mask` no bloco INTEIRO.
  it('o bloco de contato de emergência inteiro leva data-clarity-mask="True"', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    const bloco = screen.getByTestId('patient-emergency-contact-section');
    expect(bloco).toHaveAttribute('data-clarity-mask', 'True');
    expect(screen.getByTestId('emergency-contact-name').closest('[data-clarity-mask="True"]')).not.toBeNull();
  });

  // FR-203/204 (spec 018 PR-3): "Desligamento" e o chip de alta SÓ aparecem com status ATUAL
  // DISCHARGED — supera a spec 014 US-D2 (que removeu o campo por falta de coluna; a migration
  // 425/query nova supre isso via patient_status_history).
  it('spec 018 PR-3 FR-203/204: sem status DISCHARGED, nem "Desligamento" nem o chip aparecem', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, phoneMatchesResponsible: false }} />);
    expect(screen.queryByText(/Desligamento/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('patient-discharge-chip')).not.toBeInTheDocument();
  });

  it('spec 018 PR-3 FR-203/204: status DISCHARGED mostra a linha "Desligamento" com a data e o chip de alta', () => {
    render(
      <PatientIdentityCard
        patient={{ ...patientDetailFixture, status: 'DISCHARGED', dischargedAt: '2026-07-15T00:00:00Z' }}
      />,
    );
    expect(screen.getByTestId('patient-discharge-chip')).toBeInTheDocument();
    const par = screen.getByText('Desligamento').parentElement;
    expect(par?.lastElementChild).not.toHaveTextContent('—');
  });

  // Defensivo (`?? null`): status DISCHARGED sem `dischargedAt` (campo ausente/undefined, ex.
  // backend anterior a esta rodada) mostra "—", nunca quebra a tela.
  it('status DISCHARGED sem dischargedAt (campo ausente): mostra "—", sem quebrar', () => {
    const { dischargedAt: _omit, ...withoutDischargedAt } = { ...patientDetailFixture, status: 'DISCHARGED' };
    void _omit;
    render(<PatientIdentityCard patient={withoutDischargedAt as typeof patientDetailFixture} />);
    expect(screen.getByTestId('patient-discharge-chip')).toBeInTheDocument();
    const par = screen.getByText('Desligamento').parentElement;
    expect(par?.lastElementChild).toHaveTextContent('—');
  });

  it('renders —  for null name in minimal fixture', () => {
    render(<PatientIdentityCard patient={patientDetailMinimal} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  // Spec 014 US-D2 (decisão Gabriel 03/09, item 9): o botão "Editar" fantasma (disabled, sem
  // ação) SOME — a edição de identidade já vive no card "Informações Gerais" (mesmo dado).
  it('não tem mais o botão "Editar" fantasma no cabeçalho', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
  });

  // Spec 014 US-D3 (lex D3.1): o rótulo do telefone do PACIENTE deixa de ser "Teléfono del
  // Responsable" (rótulo errado, medido em produção: 5/37 casos com dado mal atribuído).
  it('spec 014 US-D3: o telefone do paciente usa o rótulo "WhatsApp do paciente"', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, phoneMatchesResponsible: false }} />);
    expect(screen.getByText(/WhatsApp do paciente/)).toBeInTheDocument();
  });

  it('renders "—" for admission date when createdAt is an empty string (formatDate cannot parse it)', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, createdAt: '' }} />);
    // rótulo e valor são irmãos na grade — o valor é o último filho do par
    const par = screen.getByText(/Admissão/).parentElement;
    expect(par?.lastElementChild).toHaveTextContent('—');
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
    expect(screen.getByText('Endereço')).toBeInTheDocument();
    expect(screen.getByText('Palermo, CABA, Buenos Aires')).toBeInTheDocument();
  });

  it('does not render the address field when there is no fullAddress and no location parts', () => {
    render(
      <PatientIdentityCard
        patient={{ ...patientDetailFixture, addresses: [], zoneNeighborhood: null, cityLocality: null, province: null }}
      />,
    );
    expect(screen.queryByText('Endereço')).not.toBeInTheDocument();
  });

  // CONDIÇÃO 5 do lex (spec 018 PR-3): ator SÓ com `patient_identity:read` (SEM
  // `patient_address:read`) — o backend já nula addresses/cityLocality/province/zoneNeighborhood
  // (container `address`, ver patientContainerAccess.test.ts). O cabeçalho recebe exatamente essa
  // forma "pré-redigida" e o innerHTML nunca contém endereço, mesmo com o telefone (`identity`)
  // presente — provando que o card não usa uma célula mais fraca que a de origem do dado.
  it('spec 018 PR-3 CONDIÇÃO 5: com a forma que um ator SÓ patient_identity:read recebe (endereço já null pelo backend), o innerHTML não contém endereço', () => {
    const { container } = render(
      <PatientIdentityCard
        patient={{
          ...patientDetailFixture,
          addresses: null as unknown as typeof patientDetailFixture.addresses,
          cityLocality: null,
          province: null,
          zoneNeighborhood: null,
        }}
      />,
    );
    expect(screen.getByText(/WhatsApp do paciente/)).toBeInTheDocument(); // identity: sobrevive
    expect(screen.queryByText('Endereço')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain('Rua Augusta');
    expect(container.innerHTML).not.toContain('Bela Vista');
  });

  it('falls back to "—" for the MARKED contact name when both firstName and lastName are null', () => {
    render(
      <PatientIdentityCard
        patient={{
          ...patientDetailFixture,
          responsibles: [{ ...patientDetailFixture.responsibles[0], firstName: null, lastName: null }],
        }}
      />,
    );
    expect(screen.getByTestId('emergency-contact-name')).toHaveTextContent('—');
  });

  it('renders "—" for the MARKED contact document when documentType and documentNumber are both null', () => {
    render(
      <PatientIdentityCard
        patient={{
          ...patientDetailFixture,
          responsibles: [{ ...patientDetailFixture.responsibles[0], documentType: null, documentNumber: null }],
        }}
      />,
    );
    expect(screen.getByTestId('emergency-contact-document-number')).toHaveTextContent('—');
    const par = screen.getByText('Tipo de documento').parentElement;
    expect(par?.lastElementChild).toHaveTextContent('—');
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
    expect(screen.getByTestId('patient-sex')).toHaveTextContent('Masculino');
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

  // Spec 018 PR-3 (Emenda 13/09, migration 425): Gênero e Idiomas VOLTAM — FR-213.
  it('spec 018 PR-3: renders gender and languages values from the enum vocabulary', () => {
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    expect(screen.getByTestId('patient-gender')).toHaveTextContent('Masculino');
    expect(screen.getByTestId('patient-languages')).toHaveTextContent('Português, Espanhol');
  });

  // FR-240 (lex #2b): `null` = não perguntado — nunca confundido com PREFER_NOT_TO_SAY.
  it('spec 018 PR-3: gender null ("não perguntado") e languages null renderizam "—", nunca a chave i18n', () => {
    render(<PatientGeneralInfoCard patient={{ ...patientDetailFixture, gender: null, languages: null }} />);
    expect(screen.getByTestId('patient-gender')).toHaveTextContent('—');
    expect(screen.getByTestId('patient-languages')).toHaveTextContent('—');
  });

  // Defensivo (`?? ''`): idioma fora da lista fechada (nunca deveria chegar do backend após o
  // Zod, mas o componente não quebra) cai no valor CRU, via fallback do `t()`.
  it('idioma fora da lista fechada (defensivo) cai no valor cru, sem quebrar', () => {
    render(<PatientGeneralInfoCard patient={{ ...patientDetailFixture, languages: ['fr'] }} />);
    expect(screen.getByTestId('patient-languages')).toHaveTextContent('fr');
  });

  it('spec 018 PR-3: PREFER_NOT_TO_SAY é uma tradução própria, distinta de "não perguntado" (null)', () => {
    render(<PatientGeneralInfoCard patient={{ ...patientDetailFixture, gender: 'PREFER_NOT_TO_SAY' }} />);
    expect(screen.getByTestId('patient-gender')).toHaveTextContent('Prefiro não dizer');
  });

  // FR-211 (lex #3(c)): `data-clarity-mask` no card "Informações Gerais" INTEIRO.
  it('spec 018 PR-3 CONDIÇÃO 4: o card "Informações Gerais" inteiro leva data-clarity-mask="True"', () => {
    render(<PatientGeneralInfoCard patient={patientDetailFixture} />);
    const card = screen.getByTestId('patient-general-info-card');
    expect(card).toHaveAttribute('data-clarity-mask', 'True');
    expect(screen.getByTestId('patient-gender').closest('[data-clarity-mask="True"]')).not.toBeNull();
  });
});

// ── DiagnosticoCard ──────────────────────────────────────────────────────────

describe('DiagnosticoCard', () => {
  beforeEach(() => { updatePatientSection.mockReset().mockResolvedValue({ id: 'x' }); });

  it('renders card title Diagnóstico', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    expect(screen.getByText('Diagnóstico')).toBeInTheDocument();
  });

  // 05/09 (Gabriel): o texto livre `diagnosis` ("Hipótesis Diagnóstica - CID") SAIU da ficha — ao lado
  // da patología estruturada confundia e convidava a digitar errado. A coluna segue no banco.
  it('NÃO renderiza o texto livre `diagnosis` nem o rótulo "Hipótese Diagnóstica - CID"', () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    expect(patientDetailFixture.diagnosis).toBeTruthy(); // a fixture TEM valor — a ausência é decisão, não vazio
    expect(screen.queryByText('CID 6A02.5 Transtorno do espectro autista')).not.toBeInTheDocument();
    expect(screen.queryByText(/Hipótese Diagnóstica - CID/)).not.toBeInTheDocument();
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

  // 06/09 (variante B): o vazio deixou de ser `—`, que não distingue "não tem" de "não carregou".
  // A frase diz qual dos dois é — e `emergencyInstructionsRedacted` segue cobrindo "não podés ver".
  it('sem instruções (nunca preenchido) diz que não há instruções registradas', () => {
    render(<DiagnosticoCard patient={patientDetailMinimal} />);
    expect(screen.getByTestId('emergency-instructions-text').textContent).toBe('Sem instruções registradas.');
  });

  it('sem autoria (nunca editado pelo painel) não mostra a linha "Última edição"', () => {
    render(<DiagnosticoCard patient={patientDetailMinimal} />);
    expect(screen.queryByTestId('general-notes-edited')).not.toBeInTheDocument();
    expect(screen.getByTestId('general-notes-text').textContent).toBe('Sem observações registradas.');
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
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'observação nova' } });
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('patient-clinical-edit-drawer')).not.toBeInTheDocument(), { timeout: 1500 });
  });

  it('sem a prop onSaved (opcional), salvar não quebra e ainda assim fecha o drawer', async () => {
    render(<DiagnosticoCard patient={patientDetailFixture} />);
    fireEvent.click(screen.getByTestId('edit-clinical-btn'));
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'observação nova' } });
    expect(() => fireEvent.click(screen.getByTestId('pce-save'))).not.toThrow();
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('patient-clinical-edit-drawer')).not.toBeInTheDocument(), { timeout: 1500 });
  });

  // ── Spec 016 F3 (REQ-21): patología estruturada — só o título, nunca o código ──────────────
  describe('patología estruturada (spec 016 F3)', () => {
    const ATIVO_PRINCIPAL = { id: 'diag-1', uri: 'http://id.who.int/icd/release/11/2026-01/mms/1683919430', title: 'Esquizofrenia', isPrimary: true, source: 'PANEL', active: true };
    const ATIVO_SECUNDARIO = { id: 'diag-2', uri: 'u2', title: 'Trastorno esquizoafectivo', isPrimary: false, source: 'PANEL', active: true };
    const INATIVO = { id: 'diag-3', uri: 'u3', title: 'Diagnóstico dado de baixa', isPrimary: false, source: 'PANEL', active: false };

    it('diagnosesUnavailable:true mostra "não foi possível carregar" — NUNCA lista vazia (bulkhead C4)', () => {
      render(<DiagnosticoCard patient={{ ...patientDetailFixture, diagnoses: [], diagnosesUnavailable: true }} />);
      expect(screen.getByTestId('diagnostico-card-unavailable')).toHaveTextContent('Não foi possível carregar o diagnóstico.');
      expect(screen.queryByTestId('diagnostico-card-patologias')).not.toBeInTheDocument();
    });

    it('diagnoses:[] com diagnosesUnavailable:false mostra "sem diagnóstico registrado" (paciente sem diagnóstico de verdade)', () => {
      render(<DiagnosticoCard patient={{ ...patientDetailFixture, diagnoses: [], diagnosesUnavailable: false }} />);
      expect(screen.getByTestId('diagnostico-card-patologias-empty')).toHaveTextContent('Nenhum diagnóstico registrado.');
      expect(screen.queryByTestId('diagnostico-card-unavailable')).not.toBeInTheDocument();
    });

    it('lista com diagnósticos ativos: mostra a patología (título), NUNCA o código/URI; inativo fica fora', () => {
      render(<DiagnosticoCard patient={{ ...patientDetailFixture, diagnoses: [ATIVO_PRINCIPAL, ATIVO_SECUNDARIO, INATIVO], diagnosesUnavailable: false }} />);
      const box = screen.getByTestId('diagnostico-card-patologias');
      expect(box).toHaveTextContent('Esquizofrenia');
      expect(box).toHaveTextContent('Trastorno esquizoafectivo');
      expect(box).not.toHaveTextContent('Diagnóstico dado de baixa');
      expect(box.innerHTML).not.toContain('1683919430');
      expect(box.innerHTML).not.toContain('6A20');
    });

    it('o principal leva o rótulo "Principal"; o secundário não', () => {
      render(<DiagnosticoCard patient={{ ...patientDetailFixture, diagnoses: [ATIVO_PRINCIPAL, ATIVO_SECUNDARIO], diagnosesUnavailable: false }} />);
      // 06/09: o marcador virou CHIP (variante B do rearranjo) — perdeu os dois pontos do formato
      // "Rótulo: valor" antigo, mas segue sendo o único jeito de distinguir principal de secundário.
      const principalRow = screen.getByTestId(`diagnostico-card-patologia-${ATIVO_PRINCIPAL.id}`);
      expect(principalRow).toHaveTextContent('Principal');
      const secundarioRow = screen.getByTestId(`diagnostico-card-patologia-${ATIVO_SECUNDARIO.id}`);
      expect(secundarioRow).not.toHaveTextContent('Principal');
    });

    it('label "Tipos de patologias - ICHOM" NUNCA aparece no card', () => {
      render(<DiagnosticoCard patient={{ ...patientDetailFixture, diagnoses: [ATIVO_PRINCIPAL], diagnosesUnavailable: false }} />);
      expect(screen.queryByText(/ICHOM/)).not.toBeInTheDocument();
    });
  });
});

// ── ProjetoTerapeuticoCard: deixou de ser placeholder na spec 017 — testes em
//    `__tests__/ProjetoTerapeuticoCard.test.tsx`.

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

  it('renders the profile column from is_team (no specialty column exists in the API)', () => {
    render(<EquipeTratanteCard professionals={patientDetailFixture.professionals} />);
    expect(screen.getByText('Profissional')).toBeInTheDocument();
  });

  it('renders professional phone', () => {
    render(<EquipeTratanteCard professionals={patientDetailFixture.professionals} />);
    expect(screen.getByText('+55 (11) 97580-1332')).toBeInTheDocument();
  });

  it('renders empty state when no professionals', () => {
    render(<EquipeTratanteCard professionals={[]} />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
  });

  // Spec 018 PR-5 (US-11): o "Nuevo" agora É real (POST /patients/:id/professionals sob
  // patient_care_team:write) — sem `patientId` ele existe mas fica desabilitado (nunca chama a
  // API sem paciente); a busca decorativa nunca existiu de verdade e continua fora.
  it('sem patientId, o botão "Novo" existe mas fica desabilitado; sem busca decorativa', () => {
    render(<EquipeTratanteCard professionals={[]} />);
    expect(screen.getByTestId('equipe-tratante-add')).toBeDisabled();
    expect(screen.queryByPlaceholderText('Pesquisar')).not.toBeInTheDocument();
  });

  it('renderiza a coluna Especialidad traduzida (migration 427, spec 018 PR-5)', () => {
    render(<EquipeTratanteCard professionals={[
      { id: 'p1', name: 'Dr. Kine', phone: null, email: null, specialty: 'PHYSIOTHERAPIST', displayOrder: 1, isTeam: false },
    ]} />);
    expect(screen.getByText('Fisioterapeuta')).toBeInTheDocument();
  });

  it('especialidade null renderiza travessão, nunca quebra (legado ou equipe multidisciplinar)', () => {
    render(<EquipeTratanteCard professionals={[
      { id: 'p1', name: 'Equipo', phone: null, email: null, specialty: null, displayOrder: 1, isTeam: true },
    ]} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

// ── D286 (ABAC) — patient_care_team:write gateia Nuevo/lápis/desativar (spec 018 PR-5) ────────
describe('EquipeTratanteCard — gate ABAC patient_care_team:write (spec 018 PR-5)', () => {
  const professionals = [
    { id: 'p1', name: 'Dr. Kine', phone: '+54 11 5555-0002', email: null, specialty: 'PHYSIOTHERAPIST' as const, displayOrder: 1, isTeam: false },
  ];
  const contrato = (permissions: string[]): AuthzContract => ({
    uid: 'u-abac-test', tenantId: 't1', status: 'ACTIVE', permissions, countries: ['AR'], groups: [], features: {},
  });

  afterEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('enforcement "on" SEM patient_care_team:write: Nuevo/lápis/desativar NÃO existem (D269 — escondido, não desabilitado)', () => {
    useAdminAuthStore.setState({ authz: { ...contrato([]), enforcement: 'on' }, authzStatus: 'ready' });
    render(<EquipeTratanteCard professionals={professionals} patientId="p1" />);
    expect(screen.queryByTestId('equipe-tratante-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('equipe-tratante-edit-p1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('equipe-tratante-deactivate-p1')).not.toBeInTheDocument();
    // Leitura continua: a tabela em si não depende da célula de ESCRITA.
    expect(screen.getByText('Dr. Kine')).toBeInTheDocument();
  });

  it('enforcement "on" COM patient_care_team:write: os três botões existem', () => {
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_care_team:write']), enforcement: 'on' }, authzStatus: 'ready' });
    render(<EquipeTratanteCard professionals={professionals} patientId="p1" />);
    expect(screen.getByTestId('equipe-tratante-add')).toBeInTheDocument();
    expect(screen.getByTestId('equipe-tratante-edit-p1')).toBeInTheDocument();
    expect(screen.getByTestId('equipe-tratante-deactivate-p1')).toBeInTheDocument();
  });

  it('clicar em "Nuevo" abre o drawer de criação (professional=null)', () => {
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_care_team:write']), enforcement: 'on' }, authzStatus: 'ready' });
    render(<EquipeTratanteCard professionals={professionals} patientId="p1" />);
    fireEvent.click(screen.getByTestId('equipe-tratante-add'));
    expect(screen.getByTestId('professional-edit-drawer')).toBeInTheDocument();
    expect((screen.getByTestId('professional-name') as HTMLInputElement).value).toBe('');
  });

  it('fechar o drawer (X) chama o onClose do card e o desmonta', async () => {
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_care_team:write']), enforcement: 'on' }, authzStatus: 'ready' });
    render(<EquipeTratanteCard professionals={professionals} patientId="p1" />);
    fireEvent.click(screen.getByTestId('equipe-tratante-add'));
    expect(screen.getByTestId('professional-edit-drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Fechar'));
    // O drawer anima a saída (CLOSE_MS) antes de chamar onClose — espera pelo desmonte real.
    await waitFor(() => expect(screen.queryByTestId('professional-edit-drawer')).not.toBeInTheDocument(), { timeout: 1000 });
  });

  it('criar com sucesso pelo drawer chama o onSaved do card', async () => {
    mockCreateProfessional.mockResolvedValueOnce({ id: 'novo' });
    const onSaved = vi.fn();
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_care_team:write']), enforcement: 'on' }, authzStatus: 'ready' });
    render(<EquipeTratanteCard professionals={professionals} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('equipe-tratante-add'));
    fireEvent.change(screen.getByTestId('professional-name'), { target: { value: 'Dr. Novo' } });
    fireEvent.click(screen.getByTestId('professional-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('clicar no lápis abre o drawer de edição PRÉ-PREENCHIDO com a linha clicada', () => {
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_care_team:write']), enforcement: 'on' }, authzStatus: 'ready' });
    render(<EquipeTratanteCard professionals={professionals} patientId="p1" />);
    fireEvent.click(screen.getByTestId('equipe-tratante-edit-p1'));
    expect(screen.getByTestId('professional-edit-drawer')).toBeInTheDocument();
    expect((screen.getByTestId('professional-name') as HTMLInputElement).value).toBe('Dr. Kine');
  });

  it('clicar no lixeiro abre a confirmação; Cancelar fecha sem chamar a API (C8)', () => {
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_care_team:write']), enforcement: 'on' }, authzStatus: 'ready' });
    render(<EquipeTratanteCard professionals={professionals} patientId="p1" />);
    fireEvent.click(screen.getByTestId('equipe-tratante-deactivate-p1'));
    expect(screen.getByTestId('deactivate-professional-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('deactivate-professional-name').textContent).toBe('Dr. Kine');
    fireEvent.click(screen.getByText('Cancelar'));
    expect(screen.queryByTestId('deactivate-professional-confirm')).not.toBeInTheDocument();
    expect(mockDeactivateProfessional).not.toHaveBeenCalled();
  });

  it('confirmar desativação chama a API com (patientId, id) e fecha o modal ao concluir; onSaved é chamado', async () => {
    mockDeactivateProfessional.mockResolvedValueOnce({ id: 'p1', active: false });
    const onSaved = vi.fn();
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_care_team:write']), enforcement: 'on' }, authzStatus: 'ready' });
    render(<EquipeTratanteCard professionals={professionals} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('equipe-tratante-deactivate-p1'));
    fireEvent.click(screen.getByTestId('deactivate-professional-confirm-button'));
    await waitFor(() => expect(mockDeactivateProfessional).toHaveBeenCalledWith('p1', 'p1'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('deactivate-professional-confirm')).not.toBeInTheDocument());
  });

  it('profissional sem nome (legado): a confirmação mostra "—" (branch `name ?? \'—\'`)', () => {
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_care_team:write']), enforcement: 'on' }, authzStatus: 'ready' });
    const semNome = [{ id: 'p9', name: null, phone: null, email: null, specialty: null, displayOrder: 1, isTeam: false }];
    render(<EquipeTratanteCard professionals={semNome} patientId="p1" />);
    fireEvent.click(screen.getByTestId('equipe-tratante-deactivate-p9'));
    expect(screen.getByTestId('deactivate-professional-name').textContent).toBe('—');
  });

  it('confirmDeactivate: guarda defensiva — sem patientId, não chama a API mesmo se deactivating estiver setado', async () => {
    mockDeactivateProfessional.mockClear();
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_care_team:write']), enforcement: 'on' }, authzStatus: 'ready' });
    const { rerender } = render(<EquipeTratanteCard professionals={professionals} patientId="p1" />);
    fireEvent.click(screen.getByTestId('equipe-tratante-deactivate-p1'));
    expect(screen.getByTestId('deactivate-professional-confirm')).toBeInTheDocument();
    // patientId some (ex.: navegação/refetch no meio) — a confirmação clicada não pode chamar a API.
    rerender(<EquipeTratanteCard professionals={professionals} />);
    fireEvent.click(screen.getByTestId('deactivate-professional-confirm-button'));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockDeactivateProfessional).not.toHaveBeenCalled();
  });
});

// ── SupervisaoCard ───────────────────────────────────────────────────────────

// Spec 014 US-D2: card sem dado nenhum vira "título + Próximamente REAL".
describe('SupervisaoCard', () => {
  it('renders card title Supervisão', () => {
    render(<SupervisaoCard />);
    expect(screen.getByText('Supervisão')).toBeInTheDocument();
  });

  it('mostra "Em breve" — sem tabela, sem botão, sem busca', () => {
    render(<SupervisaoCard />);
    expect(screen.getByText('Em breve')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

// ── RelatoriosAtendimentosCard ───────────────────────────────────────────────

// Spec 014 US-D2: card sem dado nenhum vira "título + Próximamente REAL".
describe('RelatoriosAtendimentosCard', () => {
  it('renders card title Relatórios de Atendimentos', () => {
    render(<RelatoriosAtendimentosCard />);
    expect(screen.getByText('Relatórios de Atendimentos')).toBeInTheDocument();
  });

  it('mostra "Em breve" — sem tabela, sem botões, sem busca', () => {
    render(<RelatoriosAtendimentosCard />);
    expect(screen.getByText('Em breve')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

// ── PatientProfileTabs ───────────────────────────────────────────────────────

describe('PatientProfileTabs', () => {
  // Spec 014 US-D2: "Dados Financeiros" e "Agendamentos" SAÍRAM do tab bar — só tinham o
  // placeholder genérico "Em breve" atrás, nenhum card real (decisão Gabriel 03/09, item 9).
  // 05/09 (decisão do Gabriel): "Enquadre" também saiu — era a tabela de serviços duplicada +
  // placeholder; o encuadre do paciente É o serviço contratado (endereço + horário).
  it('renders the 5 tabs with real content — "Dados Financeiros"/"Agendamentos"/"Enquadre" não existem mais', () => {
    const onTabChange = vi.fn();
    render(<PatientProfileTabs activeTab="clinicalData" onTabChange={onTabChange} />);
    expect(screen.getByText('Dados Clínicos')).toBeInTheDocument();
    expect(screen.getByText('Rede de Apoio')).toBeInTheDocument();
    expect(screen.getByText('Serviço Contratado')).toBeInTheDocument();
    expect(screen.getByText('Vagas')).toBeInTheDocument();
    expect(screen.getByText('Histórico')).toBeInTheDocument();
    expect(screen.queryByText('Dados Financeiros')).not.toBeInTheDocument();
    expect(screen.queryByText('Agendamentos')).not.toBeInTheDocument();
    expect(screen.queryByText('Enquadre')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(5);
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

  // Spec 014 US-D2: a busca decorativa `readOnly` some.
  it('não tem mais a busca decorativa', () => {
    render(<FamiliaresCard responsibles={[]} />);
    expect(screen.queryByPlaceholderText('Pesquisar')).not.toBeInTheDocument();
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
        displayOrder: 2,
        source: 'clickup',
      },
    ];
    render(<FamiliaresCard responsibles={many} />);
    expect(screen.getByText('Luciana Soto')).toBeInTheDocument();
    expect(screen.getByText('João Silva')).toBeInTheDocument();
  });

  // Spec 018, PR-2 (D-A): a coluna de emergência — só existe COM patientId.
  it('com patientId: mostra o botão de marcar emergência; a linha marcada mostra "quitar"', () => {
    render(<FamiliaresCard responsibles={patientDetailFixture.responsibles} patientId="p1" emergencyContactRef={{ kind: 'RESPONSIBLE', id: patientDetailFixture.responsibles[0].id }} />);
    expect(screen.getByTestId(`emergency-mark-RESPONSIBLE-${patientDetailFixture.responsibles[0].id}`)).toHaveTextContent(t('admin.patients.editDrawer.unmarkEmergencyContact'));
  });

  it('sem emergencyContactRef (ou apontando para outro kind/id): mostra "marcar"', () => {
    render(<FamiliaresCard responsibles={patientDetailFixture.responsibles} patientId="p1" />);
    expect(screen.getByTestId(`emergency-mark-RESPONSIBLE-${patientDetailFixture.responsibles[0].id}`)).toHaveTextContent(t('admin.patients.editDrawer.markEmergencyContact'));
  });

  it('clicar no botão de emergência chama a API e o onSaved do card (refetch)', async () => {
    const onSaved = vi.fn();
    render(<FamiliaresCard responsibles={patientDetailFixture.responsibles} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId(`emergency-mark-RESPONSIBLE-${patientDetailFixture.responsibles[0].id}`));
    await waitFor(() => expect(markEmergencyContact).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

// ── FamiliaresCard — conserto Gabriel 13/09 (PR-2 fix defeito 2): a coluna "Emergencia" é
// INFORMAÇÃO (quem é o contato marcado), não uma ação — não pode depender de patient_family:write.
// `EmergencyMarkButton` é um `ActionButton` (D269: sem a célula de escrita, SOME do DOM), então
// sem um indicador PRÓPRIO a coluna fica vazia pra quem só tem `:read`, mesmo com a linha marcada
// (evidência: specs/018-planning-0909-ficha-admissao/evidencias/pr-3-local/2-admission-com-marca.png
// — o cabeçalho mostra "Responsavel Marcado016197" como contato de emergência, mas a tabela de
// Familiares não mostra nada na coluna Emergencia).
describe('FamiliaresCard — coluna Emergencia é informação, não ação (D269 não pode escondê-la)', () => {
  const contrato = (permissions: string[]): AuthzContract => ({
    uid: 'u-abac-test', tenantId: 't1', status: 'ACTIVE', permissions, countries: ['AR'], groups: [], features: {},
  });

  afterEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('enforcement "on" SEM patient_family:write: o botão de ação some (D269), mas a linha MARCADA mostra o indicador de emergência mesmo assim', () => {
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_family:read']), enforcement: 'on' }, authzStatus: 'ready' });
    render(
      <FamiliaresCard
        responsibles={patientDetailFixture.responsibles}
        patientId="p1"
        emergencyContactRef={{ kind: 'RESPONSIBLE', id: patientDetailFixture.responsibles[0].id }}
      />,
    );
    expect(screen.queryByTestId(`emergency-mark-RESPONSIBLE-${patientDetailFixture.responsibles[0].id}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`familiares-emergency-marked-${patientDetailFixture.responsibles[0].id}`)).toBeInTheDocument();
  });

  it('enforcement "on" SEM patient_family:write: linha NÃO marcada não mostra indicador nenhum', () => {
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_family:read']), enforcement: 'on' }, authzStatus: 'ready' });
    render(<FamiliaresCard responsibles={patientDetailFixture.responsibles} patientId="p1" emergencyContactRef={null} />);
    expect(screen.queryByTestId(`familiares-emergency-marked-${patientDetailFixture.responsibles[0].id}`)).not.toBeInTheDocument();
  });

  it('enforcement "on" COM patient_family:write: mostra o indicador E o botão de ação juntos na linha marcada', () => {
    useAdminAuthStore.setState({ authz: { ...contrato(['patient_family:read', 'patient_family:write']), enforcement: 'on' }, authzStatus: 'ready' });
    render(
      <FamiliaresCard
        responsibles={patientDetailFixture.responsibles}
        patientId="p1"
        emergencyContactRef={{ kind: 'RESPONSIBLE', id: patientDetailFixture.responsibles[0].id }}
      />,
    );
    expect(screen.getByTestId(`familiares-emergency-marked-${patientDetailFixture.responsibles[0].id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`emergency-mark-RESPONSIBLE-${patientDetailFixture.responsibles[0].id}`)).toHaveTextContent(t('admin.patients.editDrawer.unmarkEmergencyContact'));
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

  // Spec 014 US-D2: "Números de Emergência" era `value={null}` fixo, sem coluna no schema —
  // removido (decisão Gabriel 03/09, item 9).
  it('não mostra mais o campo fantasma "Números de Emergência"', () => {
    render(<CoberturaMedicaCard patient={withInsurance} />);
    expect(screen.queryByText('Números de Emergência')).not.toBeInTheDocument();
  });

  it('renders "—" when insurance fields are null', () => {
    render(<CoberturaMedicaCard patient={patientDetailMinimal} />);
    const dashes = screen.getAllByText('—');
    // 3 campos reais (provedor, verificada, credencial) — "Números de Emergência" foi removido.
    expect(dashes.length).toBeGreaterThanOrEqual(3);
  });

  it('spec 012 US-B3: Editar abre o drawer de cobertura; onSaved é repassado', async () => {
    const onSaved = vi.fn();
    render(<CoberturaMedicaCard patient={withInsurance} onSaved={onSaved} />);
    const btn = screen.getByTestId('edit-coverage-btn');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(screen.getByTestId('patient-coverage-edit-drawer')).toBeInTheDocument();
    // sem onSaved também não quebra (ramo `onSaved?.()`)
    render(<CoberturaMedicaCard patient={withInsurance} />);
    fireEvent.click(screen.getAllByTestId('edit-coverage-btn')[1]);
    expect(screen.getAllByTestId('patient-coverage-edit-drawer')).toHaveLength(2);
  });

  it('spec 012 US-B3: verificadas por CÓDIGO aparecem traduzidas e têm precedência sobre o escalar cru', () => {
    render(<CoberturaMedicaCard patient={{ ...withInsurance, insuranceVerifiedCodes: ['OSDE', 'SWISS_MEDICAL', 'CODIGO_NOVO'] }} />);
    expect(screen.getByTestId('coverage-verified')).toHaveTextContent('OSDE, Swiss Medical, CODIGO_NOVO');
    expect(screen.queryByText('Plano Unimed Empresarial')).not.toBeInTheDocument();
  });
});

// ── LocalizacoesCard ─────────────────────────────────────────────────────────

describe('LocalizacoesCard', () => {
  it('renders card title', () => {
    render(<LocalizacoesCard addresses={patientDetailFixture.addresses} />);
    expect(screen.getByText('Localizações')).toBeInTheDocument();
  });

  it('Dirección em 2 linhas: linha 1 é rua+número (streetLineOf), linha 2 é a Zona quando existe (spec Localizaciones Fase 1, T3 + achado do gate)', () => {
    // 'Rua Augusta, 975 - São Paulo/SP' é o formato BR REAL (número e o que vem depois no MESMO
    // segmento) — achado do gate revisao-pr: a linha 1 tem de levar o número também.
    render(<LocalizacoesCard addresses={patientDetailFixture.addresses} />);
    expect(screen.getByText('Rua Augusta, 975')).toBeInTheDocument();
    expect(screen.getByText('Bela Vista')).toBeInTheDocument();
  });

  it('sem Zona, a linha 2 cai no resumo de localidade de summarizeAddress (sem repetir rua+número, sem sufixo de país)', () => {
    render(<LocalizacoesCard addresses={[{ ...patientDetailFixture.addresses[0], neighborhood: null }]} />);
    expect(screen.getByText('Rua Augusta, 975')).toBeInTheDocument();
    expect(screen.getByText('São Paulo/SP')).toBeInTheDocument();
  });

  it('sem vírgula nenhuma, a linha 1 é o texto inteiro (streetLineOf sem padrão reconhecido cai no 1º segmento)', () => {
    render(<LocalizacoesCard addresses={[{ ...patientDetailFixture.addresses[0], addressFormatted: 'Endereço sem vírgula', neighborhood: 'Alguma Zona' }]} />);
    expect(screen.getByText('Endereço sem vírgula')).toBeInTheDocument();
  });

  // ── Achado MINOR do gate revisao-pr, 2ª rodada: linha 2 repetia a linha 1 quando nenhuma
  // rua era reconhecida (o 1º segmento vira linha 1 pelo fallback, e sobrava no resumo de
  // novo). Medido pelo gate com estes 2 endereços exatos.
  it('sem NENHUMA rua reconhecida, a linha 2 não repete a linha 1 (endereço só de localidade)', () => {
    render(<LocalizacoesCard addresses={[{ ...patientDetailFixture.addresses[0], addressFormatted: 'Tigre, Provincia de Buenos Aires, Argentina', neighborhood: null }]} />);
    expect(screen.getAllByText('Tigre')).toHaveLength(1);
    expect(screen.getByText('Provincia de Buenos Aires')).toBeInTheDocument();
  });

  it('"Barrio X" não é reconhecido como rua: a linha 2 não repete o nome do barrio', () => {
    render(<LocalizacoesCard addresses={[{ ...patientDetailFixture.addresses[0], addressFormatted: 'Barrio Los Pinos, Pilar, Buenos Aires, Argentina', neighborhood: null }]} />);
    expect(screen.getAllByText('Barrio Los Pinos')).toHaveLength(1);
    expect(screen.getByText('Pilar, Buenos Aires')).toBeInTheDocument();
  });

  it('endereço sem addressFormatted e sem addressRaw mostra o alerta "Sem endereço cadastrado" (sem ação falsa)', () => {
    render(<LocalizacoesCard addresses={[{ ...patientDetailFixture.addresses[0], addressFormatted: null, addressRaw: null }]} />);
    expect(screen.getByTestId('address-missing-addr1')).toHaveTextContent('Sem endereço cadastrado');
  });

  it('spec 019: selo Principal (de isPrimary/is_default) e rótulo do TIPO (address_type) são campos independentes — mostram-se JUNTOS', () => {
    // Antes da spec 019, `isPrimary` era 100% derivado de `address_type === 'primary'`
    // (PatientDetailQueryHelper.ts:228) — mostrar os dois juntos repetia a palavra "Principal",
    // por isso o card fazia OU selo OU rótulo. Agora `is_default` é a marca real da operação,
    // independente do tipo por parentesco — os dois convivem na mesma célula.
    const principalComTipo = { ...patientDetailFixture.addresses[0], addressType: 'domicilio_propio', isPrimary: true };
    render(<LocalizacoesCard addresses={[principalComTipo]} />);
    const badge = screen.getByTestId('address-primary-badge-addr1');
    expect(badge).toHaveTextContent('Principal');
    expect(badge.closest('td')).toHaveTextContent('Domicílio próprio');

    const secundario = { ...patientDetailFixture.addresses[0], id: 'addr2', addressType: 'secondary', addressTypeOther: null, isPrimary: false };
    render(<LocalizacoesCard addresses={[secundario]} />);
    expect(screen.queryByTestId('address-primary-badge-addr2')).not.toBeInTheDocument();
    expect(screen.getByText('Não especificado')).toBeInTheDocument();
  });

  // Achado do gate `revisao-pr` (migration 434, D323): `typeLabel` tinha que usar a MESMA
  // validação do drawer — 'primary'/'secondary'/'service' são chaves antigas (pré-434), não
  // parentesco novo; qualquer linha que ainda as carregue cai em "sin especificar", igual ao
  // <select> do drawer (`patientAddressTypeSchema`, `.catch(null)`). Valor novo da lista fechada
  // (`casa_madre`) continua mostrando o rótulo certo.
  it('spec 019 (D323): tipo legado (primary/secondary/service) mostra "Sin especificar" — só a lista fechada por parentesco tem rótulo próprio', () => {
    const primary = { ...patientDetailFixture.addresses[0], addressType: 'primary', isPrimary: false };
    render(<LocalizacoesCard addresses={[primary]} />);
    expect(screen.getByText('Não especificado')).toBeInTheDocument();

    const service = { ...patientDetailFixture.addresses[0], id: 'addr3', addressType: 'service', isPrimary: false };
    render(<LocalizacoesCard addresses={[service]} />);
    expect(screen.getAllByText('Não especificado').length).toBeGreaterThan(0);

    const casaMadre = { ...patientDetailFixture.addresses[0], id: 'addr4', addressType: 'casa_madre', isPrimary: false };
    render(<LocalizacoesCard addresses={[casaMadre]} />);
    expect(screen.getByText('Casa da mãe')).toBeInTheDocument();
  });

  it('spec 019: address_type NULL mostra "Não especificado" e o aviso de sem principal aparece quando nenhum endereço é principal', () => {
    const semTipoNemPrincipal = { ...patientDetailFixture.addresses[0], addressType: null, isPrimary: false };
    render(<LocalizacoesCard addresses={[semTipoNemPrincipal]} patientId="p1" />);
    expect(screen.getByText('Não especificado')).toBeInTheDocument();
    expect(screen.getByTestId('address-no-principal-warning')).toHaveTextContent('Sem principal');
  });

  it('spec 019 (US 4.2): ação inline "Marcar como principal" — some quando já é principal, PATCH is_default:true quando clicada', async () => {
    updatePatientAddressLogistics.mockClear();
    const onSaved = vi.fn();
    const secundario = { ...patientDetailFixture.addresses[0], id: 'addr2', isPrimary: false };
    render(<LocalizacoesCard addresses={[secundario]} patientId="p1" onSaved={onSaved} />);
    // Endereço já principal não mostra a ação (não existe "marcar principal" pra quem já é).
    expect(screen.queryByTestId('address-mark-primary-addr1')).not.toBeInTheDocument();

    const markBtn = screen.getByTestId('address-mark-primary-addr2');
    fireEvent.click(markBtn);
    await waitFor(() => expect(updatePatientAddressLogistics).toHaveBeenCalledWith('p1', 'addr2', { is_default: true }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('spec 019 (US 4.2): botão fica disabled enquanto o PATCH está pendente — reentrância dupla é bloqueada pelo DOM, não precisa de guarda em JS', async () => {
    updatePatientAddressLogistics.mockClear();
    let resolveCall: (() => void) | undefined;
    updatePatientAddressLogistics.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCall = () => resolve({ id: 'addr2' }); }),
    );
    const secundario = { ...patientDetailFixture.addresses[0], id: 'addr2', isPrimary: false };
    render(<LocalizacoesCard addresses={[secundario]} patientId="p1" />);
    const markBtn = screen.getByTestId('address-mark-primary-addr2');
    fireEvent.click(markBtn);
    expect(markBtn).toBeDisabled();
    resolveCall?.();
    await waitFor(() => expect(markBtn).not.toBeDisabled());
    expect(updatePatientAddressLogistics).toHaveBeenCalledTimes(1);
  });

  // F1 (gate revisao-pr): o `try/finally` de `onMarkPrimary` não tinha `catch` — um 409
  // (concorrência, spec 019 §Concorrência) ou 500 virava promise rejeitada sem NENHUM aviso;
  // o spinner só parava e a operadora não sabia se salvou.
  it('F1: 409 (outra pessoa marcou principal ao mesmo tempo) mostra mensagem de conflito e recarrega os endereços', async () => {
    updatePatientAddressLogistics.mockClear().mockRejectedValueOnce(
      new PatientApiError('Conflict', 409),
    );
    const onSaved = vi.fn();
    const secundario = { ...patientDetailFixture.addresses[0], id: 'addr2', isPrimary: false };
    render(<LocalizacoesCard addresses={[secundario]} patientId="p1" onSaved={onSaved} />);

    fireEvent.click(screen.getByTestId('address-mark-primary-addr2'));
    const err = await screen.findByTestId('address-mark-primary-error');
    expect(err).toHaveTextContent('Outra pessoa já trocou o principal');
    // 409 recarrega os endereços — o card já tem essa função de recarga (onSaved).
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.getByTestId('address-mark-primary-addr2')).not.toBeDisabled();
  });

  it('F1: erro genérico (500/rede) mostra mensagem genérica, sem recarregar', async () => {
    updatePatientAddressLogistics.mockClear().mockRejectedValueOnce(new Error('boom'));
    const onSaved = vi.fn();
    const secundario = { ...patientDetailFixture.addresses[0], id: 'addr2', isPrimary: false };
    render(<LocalizacoesCard addresses={[secundario]} patientId="p1" onSaved={onSaved} />);

    fireEvent.click(screen.getByTestId('address-mark-primary-addr2'));
    const err = await screen.findByTestId('address-mark-primary-error');
    expect(err).toHaveTextContent('Não foi possível marcar como principal');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('renders empty state when no addresses', () => {
    render(<LocalizacoesCard addresses={[]} />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
  });

  it('Novo fica desabilitado sem patientId; com patientId abre o drawer de criação (spec 012 US-B2)', () => {
    render(<LocalizacoesCard addresses={[]} />);
    expect(screen.getByTestId('new-address-btn')).toBeDisabled();
    render(<LocalizacoesCard addresses={[]} patientId="p1" />);
    const btn = screen.getAllByTestId('new-address-btn')[1];
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(screen.getByTestId('patient-address-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('pad-address')).toBeInTheDocument(); // modo criar
  });

  it('spec 012 US-B2: a Zona aparece na 2ª linha da Dirección, dentro do bloco mascarado; lápis abre a edição da logística', () => {
    const onSaved = vi.fn();
    render(<LocalizacoesCard addresses={patientDetailFixture.addresses} patientId="p1" onSaved={onSaved} />);
    const zona = screen.getByText('Bela Vista');
    expect(zona.closest('[data-clarity-mask="True"]')).not.toBeNull();
    fireEvent.click(screen.getByTestId('edit-address-addr1'));
    expect(screen.getByTestId('patient-address-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('pad-address-readonly')).toHaveTextContent('Rua Augusta, 975 - São Paulo/SP');
    expect(screen.getByTestId('pad-access')).toHaveValue('Portaria 24h, interfone 701');
  });

  it('sem patientId não há coluna de edição', () => {
    render(<LocalizacoesCard addresses={[{ ...patientDetailFixture.addresses[0], neighborhood: null, logisticsCorridor: null, accessNotes: null }]} />);
    expect(screen.queryByTestId('edit-address-addr1')).not.toBeInTheDocument();
  });

  it('ordena o endereço Principal primeiro, mantendo a ordem relativa dos demais', () => {
    const secundario = {
      id: 'addr2', addressType: 'secondary', addressTypeOther: null, addressFormatted: 'Rua B, 10, SP, SP', addressRaw: null,
      complement: null, displayOrder: 0, lat: null, lng: null, isPrimary: false,
      neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'BR',
    };
    render(<LocalizacoesCard addresses={[secundario, patientDetailFixture.addresses[0]]} />);
    const linhas = screen.getAllByRole('row').slice(1); // pula o cabeçalho
    expect(linhas[0]).toHaveTextContent('Rua Augusta');
    expect(linhas[1]).toHaveTextContent('Rua B');
  });

  // ── D286 (ABAC) — os DOIS ramos do gate `useActionGate('patient_address', 'write')` ────────
  // Achado do gate revisao-pr (variante stage): as 115 asserções acima já cobriam o ramo
  // ALLOWED por padrão — a store nasce com `authz: null`/`authzStatus: 'idle'`, que
  // `useActionGate` lê como `enforcement !== 'on'` e devolve `{ allowed: true }` sempre (freio
  // fail-open do D268/D269). O ramo DENIED nunca era exercitado por nenhum teste. `afterEach`
  // devolve a store ao estado neutro — é um singleton global (Zustand), não por render.
  const contrato = (permissions: string[]): AuthzContract => ({
    uid: 'u-abac-test', tenantId: 't1', status: 'ACTIVE', permissions, countries: ['AR'], groups: [], features: {},
  });

  describe('gate ABAC patient_address:write (D286)', () => {
    afterEach(() => {
      useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    });

    it('enforcement "on" SEM a célula patient_address:write: o lápis não aparece (denied)', () => {
      useAdminAuthStore.setState({ authz: { ...contrato([]), enforcement: 'on' }, authzStatus: 'ready' });
      render(<LocalizacoesCard addresses={patientDetailFixture.addresses} patientId="p1" />);
      expect(screen.queryByTestId('edit-address-addr1')).not.toBeInTheDocument();
    });

    it('enforcement "on" COM a célula patient_address:write: o lápis aparece (allowed)', () => {
      useAdminAuthStore.setState({ authz: { ...contrato(['patient_address:write']), enforcement: 'on' }, authzStatus: 'ready' });
      render(<LocalizacoesCard addresses={patientDetailFixture.addresses} patientId="p1" />);
      expect(screen.getByTestId('edit-address-addr1')).toBeInTheDocument();
    });

    // Spec 019 — "Marcar como principal" só existe em endereço NÃO principal (addr1 da fixture
    // já É o principal, nunca mostraria o botão); a mesma célula do lápis gate a ação (D286): não
    // é permissão dedicada nova, é a MESMA patient_address:write.
    const secundario = {
      id: 'addr2', addressType: 'secondary', addressTypeOther: null, addressFormatted: 'Rua B, 10, SP, SP', addressRaw: null,
      complement: null, displayOrder: 0, lat: null, lng: null, isPrimary: false,
      neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'BR',
    };

    it('enforcement "on" SEM a célula patient_address:write: "Marcar como principal" não aparece (denied)', () => {
      useAdminAuthStore.setState({ authz: { ...contrato([]), enforcement: 'on' }, authzStatus: 'ready' });
      render(<LocalizacoesCard addresses={[secundario]} patientId="p1" />);
      expect(screen.queryByTestId('address-mark-primary-addr2')).not.toBeInTheDocument();
    });

    it('enforcement "on" COM a célula patient_address:write: "Marcar como principal" aparece (allowed)', () => {
      useAdminAuthStore.setState({ authz: { ...contrato(['patient_address:write']), enforcement: 'on' }, authzStatus: 'ready' });
      render(<LocalizacoesCard addresses={[secundario]} patientId="p1" />);
      expect(screen.getByTestId('address-mark-primary-addr2')).toBeInTheDocument();
    });
  });
});

// ── ServicosContratadosCard ──────────────────────────────────────────────────
// Spec 013, bloco C (03/09): o card deixou de ler só `patient.serviceType`/`deviceType` (as 5
// colunas fantasma — "Sexo", "Quant.", "Valor", "Versión", 3ª coluna — nunca tinham dado por
// trás, #PEND-08) e passou a ler `patient.contractedServices[]`, entidade própria. O botão de
// editar abre `PatientContractedServicesEditDrawer` (lista + form por serviço), não mais
// `PatientServiceEditDrawer` (campo único). Os testes movidos + estendidos para
// `ServicosContratadosCard.test.tsx` (i18n real, molde `sex-both-i18n.test.tsx` — pega vazamento
// de enum cru, que os `getByText` literais em pt-BR abaixo não pegavam).

// ── EnquadreTerapeuticoCard ─ REMOVIDO (05/09, decisão do Gabriel): a aba "Encuadre" saiu da
// ficha — era a tabela de serviços contratados duplicada + este placeholder. O encuadre do
// paciente É o serviço contratado (endereço + horário, migration 330).

// ── Spec 011 bloco A — contrato real da API e máscara do Clarity (A2/A4) ────

describe('EquipeTratanteCard — lê o contrato da API (A2, lex C2.1/C2.2)', () => {
  const professionals = [
    { id: 'p1', name: 'Dra. Contrato Tratante', phone: '+54 11 5555-0001', email: 'dra@example.test', specialty: 'PHYSICIAN' as const, displayOrder: 1, isTeam: false },
    { id: 'p2', name: 'Equipo Interdisciplinario', phone: null, email: null, specialty: null, displayOrder: 2, isTeam: true },
  ];

  it('renderiza o NOME que a API manda (`name`, não `fullName`)', () => {
    render(<EquipeTratanteCard professionals={professionals} />);
    expect(screen.getByText('Dra. Contrato Tratante')).toBeInTheDocument();
    expect(screen.getByText('+54 11 5555-0001')).toBeInTheDocument();
  });

  it('a coluna Perfil mostra o is_team da tabela — nunca uma especialidade derivada', () => {
    render(<EquipeTratanteCard professionals={professionals} />);
    expect(screen.getByText('Equipe tratante')).toBeInTheDocument();
    expect(screen.getByText('Profissional')).toBeInTheDocument();
  });

  it('a tabela leva data-clarity-mask="True" (nome de profissional é texto: o Balanced não mascara)', () => {
    render(<EquipeTratanteCard professionals={professionals} />);
    expect(screen.getByText('Dra. Contrato Tratante').closest('[data-clarity-mask="True"]')).not.toBeNull();
  });
});

describe('LocalizacoesCard — lê o contrato da API (A2, lex C2.1)', () => {
  const base = { id: 'a1', addressType: 'primary', addressTypeOther: null, complement: 'Piso 2', displayOrder: 1, lat: -34.6, lng: -58.38, isPrimary: true, neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'AR' };

  it('renderiza addressFormatted (`fullAddress` nunca existiu na API) — linha 1 até a 1ª vírgula', () => {
    render(<LocalizacoesCard addresses={[{ ...base, addressFormatted: 'Av. Contrato 123, CABA, AR', addressRaw: 'Av. Contrato 123' }]} />);
    expect(screen.getByText('Av. Contrato 123')).toBeInTheDocument();
    expect(screen.getByText('CABA, AR')).toBeInTheDocument();
  });

  it('cai em addressRaw quando o formatado é nulo, e no alerta "Sem endereço cadastrado" quando os dois são', () => {
    render(<LocalizacoesCard addresses={[
      { ...base, id: 'a2', addressFormatted: null, addressRaw: 'Calle cruda 9' },
      { ...base, id: 'a3', addressFormatted: null, addressRaw: null, complement: null },
    ]} />);
    expect(screen.getByText('Calle cruda 9')).toBeInTheDocument();
    expect(screen.getByTestId('address-missing-a3')).toHaveTextContent('Sem endereço cadastrado');
  });

  it('o bloco de endereços leva data-clarity-mask="True" (rua é texto: sobe em claro sem isto)', () => {
    render(<LocalizacoesCard addresses={[{ ...base, addressFormatted: 'Av. Contrato 123, CABA, AR', addressRaw: null }]} />);
    expect(screen.getByText('Av. Contrato 123').closest('[data-clarity-mask="True"]')).not.toBeNull();
  });

  it('só rua+número, sem NENHUMA localidade sobrando: fica sem linha 2 (summarizeAddress devolve "")', () => {
    render(<LocalizacoesCard addresses={[{ ...base, addressFormatted: 'Rua Augusta, 975', addressRaw: null }]} />);
    expect(screen.getByText('Rua Augusta, 975')).toBeInTheDocument();
  });

  it('quando o país é o ÚNICO segmento que sobra depois da rua, a linha 2 fica null — país nunca vira linha 2 sozinho (achado MINOR do gate, 2ª rodada; desinverte o teste anterior)', () => {
    render(<LocalizacoesCard addresses={[{ ...base, addressFormatted: 'Ruta 9 km 42, Argentina', addressRaw: null }]} />);
    expect(screen.getByText('Ruta 9 km 42')).toBeInTheDocument();
    expect(screen.queryByText('Argentina')).not.toBeInTheDocument();
  });

  // ── Achados MINOR do gate revisao-pr (spec Localizaciones Fase 1) ───────────────────────
  it('addressFormatted "" (string vazia) conta como ausente — cai para addressRaw, não para o alerta', () => {
    render(<LocalizacoesCard addresses={[{ ...base, addressFormatted: '', addressRaw: 'Calle cruda 9' }]} />);
    expect(screen.getByText('Calle cruda 9')).toBeInTheDocument();
    expect(screen.queryByTestId(`address-missing-${base.id}`)).not.toBeInTheDocument();
  });

  it('addressFormatted só com espaços conta como ausente — mesma regra do addressRaw', () => {
    render(<LocalizacoesCard addresses={[{ ...base, addressFormatted: '   ', addressRaw: '   ', complement: null }]} />);
    expect(screen.getByTestId(`address-missing-${base.id}`)).toHaveTextContent('Sem endereço cadastrado');
  });

  it('texto que começa com vírgula não vira linha 1 vazia (não cai no alerta com texto presente) — e a linha 2 NÃO repete "CABA" nem mostra o país sozinho (achado MINOR do gate, 2ª rodada — a asserção anterior tolerava a repetição)', () => {
    render(<LocalizacoesCard addresses={[{ ...base, addressFormatted: ', CABA, Argentina', addressRaw: null }]} />);
    expect(screen.queryByTestId(`address-missing-${base.id}`)).not.toBeInTheDocument();
    expect(screen.getAllByText('CABA')).toHaveLength(1);
    expect(screen.queryByText('Argentina')).not.toBeInTheDocument();
  });

  it('degenerado: só vírgulas — streetLineOf devolve "" e o fallback usa o texto cru inteiro', () => {
    render(<LocalizacoesCard addresses={[{ ...base, addressFormatted: ',', addressRaw: null }]} />);
    expect(screen.getByText(',')).toBeInTheDocument();
  });
});

describe('PatientIdentityCard — e-mail do paciente em claro com máscara do Clarity (A4, lex C4.2)', () => {
  it('mostra contactEmail dentro de um container com data-clarity-mask="True"', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, contactEmail: 'santiago@example.test' }} />);
    const email = screen.getByTestId('patient-contact-email');
    expect(email).toHaveTextContent('santiago@example.test');
    expect(email.closest('[data-clarity-mask="True"]')).not.toBeNull();
  });

  it('sem e-mail mostra "—" no mesmo campo (o campo existe sempre; a ausência é visível)', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, contactEmail: null }} />);
    expect(screen.getByTestId('patient-contact-email')).toHaveTextContent('—');
  });

  it('o endereço do cabeçalho lê addresses[0].addressFormatted (A2)', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, addresses: [{ id: 'a1', addressType: 'primary', addressTypeOther: null, addressFormatted: 'Rua Contrato, 1 - SP', addressRaw: null, complement: null, displayOrder: 1, lat: null, lng: null, isPrimary: true, neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'BR' }] }} />);
    expect(screen.getByText('Rua Contrato, 1 - SP')).toBeInTheDocument();
  });
});

// ── Spec 011 — ramos defensivos dos cards tocados (cobertura 100 % do arquivo, D200) ──

describe('cards tocados na spec 011 — ramos defensivos', () => {
  it('EquipeTratanteCard: lista ausente vira vazia; nome nulo vira "—"', () => {
    const { unmount } = render(<EquipeTratanteCard professionals={undefined as unknown as []} />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
    unmount();
    render(<EquipeTratanteCard professionals={[{ id: 'p0', name: null, phone: null, email: null, specialty: null, displayOrder: 1, isTeam: false }]} />);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('LocalizacoesCard: lista ausente vira vazia', () => {
    render(<LocalizacoesCard addresses={undefined as unknown as []} />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
  });

  it('PatientIdentityCard: sem endereço formatado, o cabeçalho cai no texto cru do operador', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, addresses: [{ id: 'a1', addressType: 'primary', addressTypeOther: null, addressFormatted: null, addressRaw: 'Rua Crua 77', complement: null, displayOrder: 1, lat: null, lng: null, isPrimary: true, neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'BR' }] }} />);
    expect(screen.getByText('Rua Crua 77')).toBeInTheDocument();
  });
});

// ── QA caça 🔴2 (spec 011, rodada 2): rua no card de identidade com máscara e rótulo i18n ──

describe('PatientIdentityCard — endereço com data-clarity-mask (lex C2.1)', () => {
  const addr = { id: 'a1', addressType: 'primary', addressTypeOther: null, addressFormatted: 'Rua Mascarada, 9 - SP', addressRaw: null, complement: null, displayOrder: 1, lat: null, lng: null, isPrimary: true, neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'BR' };

  it('a rua fica dentro de um container com data-clarity-mask="True" e o rótulo vem do i18n', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, addresses: [addr] }} />);
    const field = screen.getByTestId('patient-address');
    expect(field).toHaveTextContent('Rua Mascarada, 9 - SP');
    expect(field.closest('[data-clarity-mask="True"]')).not.toBeNull();
    expect(screen.getByText('Endereço')).toBeInTheDocument();
  });

  it('sem endereço nenhum o campo não aparece', () => {
    render(<PatientIdentityCard patient={patientDetailMinimal} />);
    expect(screen.queryByTestId('patient-address')).toBeNull();
  });
});
