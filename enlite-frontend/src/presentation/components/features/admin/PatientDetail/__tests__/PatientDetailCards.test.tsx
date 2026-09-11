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
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    updatePatientSection: (...a: unknown[]) => updatePatientSection(...a),
    listInsuranceProviders: (...a: unknown[]) => listInsuranceProviders(...a),
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

  // 06/09 (Gabriel): o grupo deixou de se chamar "contato de emergência" — o cartão mostra o
  // responsável marcado como `isPrimary`, então o título passa a dizer o que o dado é.
  it('renders primary responsible section when responsible present', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    expect(screen.getByText('Contato do responsável principal')).toBeInTheDocument();
    expect(screen.getByText('Luciana Soto')).toBeInTheDocument();
  });

  // 🔒 `isPrimary` decide o TÍTULO: sem ninguém marcado, o cartão cai no primeiro da lista — e aí
  // chamá-lo de "principal" seria a tela afirmar o que o dado não diz.
  it('sem nenhum responsável marcado como principal, o título NÃO afirma "principal"', () => {
    render(
      <PatientIdentityCard
        patient={{
          ...patientDetailFixture,
          responsibles: patientDetailFixture.responsibles.map((r) => ({ ...r, isPrimary: false })),
        }}
      />,
    );
    expect(screen.getByText('Contato do responsável')).toBeInTheDocument();
    expect(screen.queryByText('Contato do responsável principal')).not.toBeInTheDocument();
    // o dado continua na tela: só o título muda
    expect(screen.getByText('Luciana Soto')).toBeInTheDocument();
  });

  // Sem responsável nenhum, o grupo inteiro some. Asserção nos DOIS títulos possíveis: buscar só
  // o rótulo antigo passaria por vácuo, já que ele não existe mais em lugar nenhum.
  // O parentesco é opcional na base: sem ele o par mostra "—", não some nem quebra.
  it('responsável sem parentesco cadastrado mostra "—" no par, sem sumir com o campo', () => {
    render(
      <PatientIdentityCard
        patient={{
          ...patientDetailFixture,
          responsibles: [{ ...patientDetailFixture.responsibles[0], relationship: null }],
        }}
      />,
    );
    const par = screen.getByText(/Parentesco/).parentElement;
    expect(par?.lastElementChild).toHaveTextContent('—');
  });

  // 🔒 Trava da classe que o print pegou e os testes não: parentesco FORA do catálogo (o enum tem
  // 9 valores) caía na chave i18n inteira na tela. `expectNoRawEnumLeaks` procura ALL_CAPS solto e
  // não casa com `admin.patients.detail.relationshipOptions.XPTO`, então esta asserção é explícita.
  it('parentesco fora do catálogo cai no valor CRU, nunca na chave i18n', () => {
    render(
      <PatientIdentityCard
        patient={{
          ...patientDetailFixture,
          responsibles: [{ ...patientDetailFixture.responsibles[0], relationship: 'XPTO' as never }],
        }}
      />,
    );
    const par = screen.getByText(/Parentesco/).parentElement;
    expect(par?.lastElementChild).toHaveTextContent('XPTO');
    expect(screen.queryByText(/admin\.patients\.detail\.relationshipOptions/)).not.toBeInTheDocument();
  });

  // lex 06/09 (C2): telefone, documento e e-mail do responsável são contato de TERCEIRO e vivem na
  // mesma grade que o e-mail do paciente, que já era mascarado. Trava: se alguém tirar o wrapper,
  // fica vermelho.
  it('o bloco do responsável inteiro leva data-clarity-mask="True"', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    const bloco = screen.getByTestId('patient-responsible-section');
    expect(bloco).toHaveAttribute('data-clarity-mask', 'True');
    // e os campos de contato estão DENTRO dele
    expect(screen.getByText('Luciana Soto').closest('[data-clarity-mask="True"]')).not.toBeNull();
    expect(screen.getByText(/99852-0481/).closest('[data-clarity-mask="True"]')).not.toBeNull();
  });

  it('does not render the responsible section when no responsibles', () => {
    render(<PatientIdentityCard patient={patientDetailMinimal} />);
    expect(screen.queryByText('Contato do responsável principal')).not.toBeInTheDocument();
    expect(screen.queryByText('Contato do responsável')).not.toBeInTheDocument();
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

  // Spec 014 US-D2: "Desligamento" era `value={null}` fixo (sem coluna no banco) — removido.
  it('spec 014 US-D2: não mostra mais o campo fantasma "Desligamento"', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, phoneMatchesResponsible: false }} />);
    expect(screen.queryByText(/Desligamento/i)).not.toBeInTheDocument();
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

  it('falls back to "—" for the responsible name when both firstName and lastName are null', () => {
    render(
      <PatientIdentityCard
        patient={{
          ...patientDetailFixture,
          responsibles: [{ ...patientDetailFixture.responsibles[0], firstName: null, lastName: null }],
        }}
      />,
    );
    const par = screen.getByText(/Nome do Responsável/).parentElement;
    expect(par?.lastElementChild).toHaveTextContent('—');
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
    const par = screen.getByText(/Tipo de documento/).parentElement;
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

  // Spec 014 US-D2: o botão "Nuevo" fantasma (disabled, sem ação — não há endpoint de criar
  // profissional nesta spec) e a busca decorativa `readOnly` SOMEM; a tabela real fica.
  it('não tem mais o botão "Novo" fantasma nem a busca decorativa', () => {
    render(<EquipeTratanteCard professionals={[]} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Pesquisar')).not.toBeInTheDocument();
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

  it('Tipo mostra SÓ o selo Principal quando isPrimary, SÓ o rótulo do address_type quando não (sem repetir a palavra)', () => {
    // Conserto pós-Fase 1 (achado da própria LISTA): `isPrimary` é 100% derivado de
    // `address_type === 'primary'` (PatientDetailQueryHelper.ts:228) — mostrar os dois juntos
    // repetia a palavra "Principal". Agora é OU selo OU rótulo, nunca os dois.
    render(<LocalizacoesCard addresses={patientDetailFixture.addresses} />);
    const badge = screen.getByTestId('address-primary-badge-addr1');
    expect(badge).toHaveTextContent('Principal');
    expect(badge.closest('td')).toHaveTextContent('Principal');
    // A célula do Tipo não repete "Principal" fora do selo — só o texto do selo existe ali.
    expect(badge.closest('td')?.textContent).toBe('Principal');

    const secundario = { ...patientDetailFixture.addresses[0], id: 'addr2', addressType: 'secondary', isPrimary: false };
    render(<LocalizacoesCard addresses={[secundario]} />);
    expect(screen.queryByTestId('address-primary-badge-addr2')).not.toBeInTheDocument();
    expect(screen.getByText('Secundário')).toBeInTheDocument();
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
      id: 'addr2', addressType: 'secondary', addressFormatted: 'Rua B, 10, SP, SP', addressRaw: null,
      complement: null, displayOrder: 0, lat: null, lng: null, isPrimary: false,
      neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'BR',
    };
    render(<LocalizacoesCard addresses={[secundario, patientDetailFixture.addresses[0]]} />);
    const linhas = screen.getAllByRole('row').slice(1); // pula o cabeçalho
    expect(linhas[0]).toHaveTextContent('Rua Augusta');
    expect(linhas[1]).toHaveTextContent('Rua B');
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
    { id: 'p1', name: 'Dra. Contrato Tratante', phone: '+54 11 5555-0001', email: 'dra@example.test', displayOrder: 1, isTeam: false },
    { id: 'p2', name: 'Equipo Interdisciplinario', phone: null, email: null, displayOrder: 2, isTeam: true },
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
  const base = { id: 'a1', addressType: 'primary', complement: 'Piso 2', displayOrder: 1, lat: -34.6, lng: -58.38, isPrimary: true, neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'AR' };

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
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, addresses: [{ id: 'a1', addressType: 'primary', addressFormatted: 'Rua Contrato, 1 - SP', addressRaw: null, complement: null, displayOrder: 1, lat: null, lng: null, isPrimary: true, neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'BR' }] }} />);
    expect(screen.getByText('Rua Contrato, 1 - SP')).toBeInTheDocument();
  });
});

// ── Spec 011 — ramos defensivos dos cards tocados (cobertura 100 % do arquivo, D200) ──

describe('cards tocados na spec 011 — ramos defensivos', () => {
  it('EquipeTratanteCard: lista ausente vira vazia; nome nulo vira "—"', () => {
    const { unmount } = render(<EquipeTratanteCard professionals={undefined as unknown as []} />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
    unmount();
    render(<EquipeTratanteCard professionals={[{ id: 'p0', name: null, phone: null, email: null, displayOrder: 1, isTeam: false }]} />);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('LocalizacoesCard: lista ausente vira vazia', () => {
    render(<LocalizacoesCard addresses={undefined as unknown as []} />);
    expect(screen.getByText('Sem dados cadastrados')).toBeInTheDocument();
  });

  it('PatientIdentityCard: sem endereço formatado, o cabeçalho cai no texto cru do operador', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, addresses: [{ id: 'a1', addressType: 'primary', addressFormatted: null, addressRaw: 'Rua Crua 77', complement: null, displayOrder: 1, lat: null, lng: null, isPrimary: true, neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'BR' }] }} />);
    expect(screen.getByText('Rua Crua 77')).toBeInTheDocument();
  });
});

// ── QA caça 🔴2 (spec 011, rodada 2): rua no card de identidade com máscara e rótulo i18n ──

describe('PatientIdentityCard — endereço com data-clarity-mask (lex C2.1)', () => {
  const addr = { id: 'a1', addressType: 'primary', addressFormatted: 'Rua Mascarada, 9 - SP', addressRaw: null, complement: null, displayOrder: 1, lat: null, lng: null, isPrimary: true, neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'BR' };

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
