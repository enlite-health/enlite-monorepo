/**
 * TherapeuticProjectForm — o formulário de UMA versão (spec 017 F4, Figma `6017:14962`).
 *
 * O que estes testes seguram:
 *  · lex C7 — versão com `redacted.clinical` NÃO pode virar versão nova: o texto clínico que eu
 *    não vejo seria reescrito por mim. O aviso aparece e "Salvar" fica travado.
 *  · D286 — o serviço contratado é escolha do operador entre os ATIVOS; sem serviço ativo não há
 *    o que vincular, e o formulário diz isso em vez de deixar salvar um vínculo vazio.
 *  · Catálogo desativado depois da versão antiga continua VISÍVEL como opção (`optionsOf`) — senão
 *    "Editar" apagaria em silêncio um item que o servidor ainda tem no snapshot.
 *  · O corpo enviado leva os textos com `trim` — espaço não é conteúdo clínico.
 *  · 091 (§9.8, DF-6): em "Nuevo" a cascata serviço → diagnósticos → blocos; o segmento saiu. A cascata usa um
 *    FAKE da porta `TherapeuticCatalogGateway` (nunca mock de `fetch`). "Editar" segue o formato da origem
 *    (`objectivesLayout`, DD-21) e é só leitura nos blocos.
 *
 * `IcdSearchCombobox` é dublê (REQ-21: o código do CID não passa por aqui); `Combobox`/`Select`
 * são os REAIS — a régua é o que o operador consegue fazer na tela, não o que a prop aceita.
 */
import { CONTRACT_058_DEFAULTS } from '@domain/entities/__tests__/fixtures/contractedService058';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type {
  PatientContractedServiceDetail,
  PatientCoverageEmergencyContact,
  PatientDiagnosisDetail,
  PatientExternalContactDetail,
  PatientProfessionalDetail,
  PatientResponsibleDetail,
} from '@domain/entities/PatientDetail';
import type {
  CascadeBlock,
  CascadeRequestBody,
  CascadeResponse,
  DiagnosisPlanSnapshot,
  TherapeuticCatalogItem,
  TherapeuticFieldClass,
  TherapeuticProjectVersion,
} from '@domain/entities/TherapeuticProject';
import type { TherapeuticCatalogGateway } from '@domain/repositories/TherapeuticCatalogGateway';
import type { TherapeuticCatalogs } from '@hooks/admin/useTherapeuticProjects';
import { patientDetailFixture } from '../../__tests__/patientDetailFixture';

// ── i18n mock (molde `PatientDetailCards.gate.test.tsx`) ─────────────────────

const translations = ptBR as Record<string, any>;

function t(key: string, optsOrDefault?: any): string {
  const parts = key.split('.');
  let current: any = translations;
  for (const part of parts) current = current?.[part];
  if (typeof current === 'string') {
    if (typeof optsOrDefault === 'object' && optsOrDefault !== null) {
      return current.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => optsOrDefault[k] ?? _);
    }
    return current;
  }
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  return key;
}

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

// Dublê do combobox de CID: dois candidatos fixos e um repetido, para exercer o "chip duplicado".
vi.mock('../../edit/IcdSearchCombobox', () => ({
  IcdSearchCombobox: ({ id, onSelect, disabled }: { id?: string; onSelect: (c: { uri: string; title: string }) => void; disabled?: boolean }) => (
    <div data-testid="icd-stub" data-id={id} data-disabled={String(disabled)}>
      <button type="button" data-testid="icd-pick-a" onClick={() => onSelect({ uri: 'urn:icd:A', title: 'Diagnóstico A' })}>A</button>
      <button type="button" data-testid="icd-pick-b" onClick={() => onSelect({ uri: 'urn:icd:B', title: 'Diagnóstico B' })}>B</button>
    </div>
  ),
}));

import { TherapeuticProjectForm } from '../TherapeuticProjectForm';

// ── Insumos ──────────────────────────────────────────────────────────────────

const tf = (k: string) => (ptBR.admin.patients.detail.therapeuticProjectForm as Record<string, any>)[k] as string;
const tc = (k: string) => (ptBR.admin.patients.detail.therapeuticProjectCard as Record<string, any>)[k] as string;

const servico = (over: Partial<PatientContractedServiceDetail> = {}): PatientContractedServiceDetail => ({
  id: 'svc-1',
  patientId: patientDetailFixture.id,
  serviceCode: 'AT',
  professionalProfile: null,
  providersNeeded: 1,
  authorization: null,
  scheduleHours: 20,
  careLocation: 'HOME',
  ...CONTRACT_058_DEFAULTS,
  startDate: null,
  supervisionFrequency: null,
  guardShift: null,
  providerAgeBand: null, requiredProfessions: null, requiredSex: null, requiredExperience: null, workerAttributes: null, workSchedule: null, paymentDay: null, dailyObs: null,
  addressId: null,
  liveVacancy: null, liveVacancyRedacted: false,
  schedule: null,
  active: true,
  endedAt: null,
  country: 'AR',
  deviceTypes: [],
  providers: [],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  ...over,
});

const item = (id: string, label: string): TherapeuticCatalogItem => ({
  id,
  label,
  sortOrder: 1,
  active: true,
  deactivatedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});

const CATALOGOS: TherapeuticCatalogs = {
  'specific-objectives': [item('so1', 'Objetivo 1'), item('so2', 'Objetivo 2')],
  activities: [item('ac1', 'Atividade 1')],
};

// Espelho de `THERAPEUTIC_FIELD_CLASS` do backend — dono único da lista MACRO×MICRO (task 7.7).
const FIELD_CLASS: TherapeuticFieldClass = {
  macro: ['contractedServiceId', 'diagnoses', 'clinicalContext', 'generalObjective', 'specificObjectiveIds', 'activityIds'],
  micro: ['startDate', 'endDate', 'modality', 'contactRefs', 'careTeamIds'],
};
/** Variante SEM macro nenhum — isola o comportamento do `optionsOf` (merge catálogo+snapshot) do gate de lock. */
const FIELD_CLASS_SEM_MACRO: TherapeuticFieldClass = { macro: [], micro: [...FIELD_CLASS.macro, ...FIELD_CLASS.micro] };

const RESPONSAVEL: PatientResponsibleDetail = {
  id: 'resp-1', firstName: 'Marta', lastName: 'Gómez', relationship: 'MOTHER', phone: '111', email: null,
  documentType: null, documentNumber: null, isPrimary: true, displayOrder: 1, source: 'admin_manual',
};
const EXTERNO: PatientExternalContactDetail = { id: 'ext-1', relation: 'Vecina', name: 'Lucía Externa', phone: '222', active: true };
const COBERTURA: PatientCoverageEmergencyContact = { id: 'cov-1', kind: 'INSURANCE_EMERGENCY', name: 'Emergencias ACME', phone: '333', sortOrder: 1 };
const PROFISSIONAL: PatientProfessionalDetail = { id: 'prof-1', name: 'Dr. Fulano', phone: null, email: null, specialty: 'PHYSICIAN', displayOrder: 1, isTeam: false };

const DIAGS: PatientDiagnosisDetail[] = [
  { id: 'd1', uri: 'urn:icd:A', title: 'Diagnóstico A', isPrimary: true, source: 'panel', active: true },
  { id: 'd2', uri: 'urn:icd:C', title: 'Diagnóstico C', isPrimary: false, source: 'panel', active: true },
  { id: 'd3', uri: 'urn:icd:Z', title: 'Diagnóstico INATIVO', isPrimary: false, source: 'panel', active: false },
];

const VERSAO: TherapeuticProjectVersion = {
  id: 'v1',
  patientId: patientDetailFixture.id,
  major: 1,
  minor: 0,
  version: 'V.1.0',
  editedFromVersionId: null,
  contractedServiceId: 'svc-2',
  contractedServiceCode: 'CAREGIVER',
  modality: 'IN_PERSON',
  diagnoses: [{ uri: 'urn:icd:B', title: 'Diagnóstico B' }],
  clinicalContext: 'contexto de origem',
  generalObjective: 'objetivo de origem',
  specificObjectives: [{ id: 'so-morto', label: 'Objetivo DESATIVADO no catálogo' }],
  activities: [{ id: 'ac1', label: 'Atividade 1' }],
  pathologyTypes: [{ id: 'pt1', label: 'Neurológica' }],
  objectivesLayout: 'flat',
  diagnosisPlans: null,
  startDate: '2026-01-10',
  endDate: '2026-06-10',
  annulledAt: null,
  annulledByName: null,
  annulReason: null,
  createdByName: 'Ana Fixture',
  createdAt: '2026-01-10T10:00:00Z',
  country: 'AR',
  contactRefs: [],
  careTeamIds: [],
  contacts: [],
  contactStatus: [],
};

// ── Fake da porta da cascata (091) ───────────────────────────────────────────

const A_URI = 'urn:icd:A';
const C_URI = 'urn:icd:C';
const objA = (uri: string) => `${uri}-o1`;

/** Bloco `ok`: dois objetivos; o 1º com 2 atividades (uma com frecuencia), o 2º com 1. */
const blocoOk = (uri: string): CascadeBlock => ({
  diagnosisUri: uri,
  categoryCode: 'AB12',
  status: 'ok',
  objectives: [
    {
      id: objA(uri), label: 'Objetivo um', description: 'Descrição do objetivo um',
      activities: [
        { id: `${uri}-a1`, label: 'Atividade um', description: 'Descrição da atividade um', suggestedFrequency: '2x por semana' },
        { id: `${uri}-a2`, label: 'Atividade dois', description: null, suggestedFrequency: null },
      ],
    },
    { id: `${uri}-o2`, label: 'Objetivo dois', description: null, activities: [{ id: `${uri}-a3`, label: 'Atividade três', description: null, suggestedFrequency: null }] },
  ],
});
const blocoSemCatalogo = (uri: string): CascadeBlock => ({ diagnosisUri: uri, categoryCode: 'ZZ99', status: 'no_catalog', objectives: [] });

/** Catálogo fixo: `urn:icd:C` não tem catálogo; os demais, sim. Registra as chamadas (como o fake do hook). */
class FakeGateway {
  calls: CascadeRequestBody[] = [];
  respond: (body: CascadeRequestBody) => Promise<CascadeResponse> = async (body) => ({
    serviceCode: body.serviceCode,
    serviceHasCatalog: true,
    blocks: body.diagnosisUris.map((u) => (u === C_URI ? blocoSemCatalogo(u) : blocoOk(u))),
  });
  async cascade(body: CascadeRequestBody): Promise<CascadeResponse> {
    this.calls.push(body);
    return this.respond(body);
  }
}

let fake: FakeGateway;

type Props = Parameters<typeof TherapeuticProjectForm>[0];

const onSubmit = vi.fn();
const onCancel = vi.fn();
const onDirty = vi.fn();

const montar = (over: Partial<Props> = {}) =>
  render(
    <TherapeuticProjectForm
      services={over.services ?? [servico(), servico({ id: 'svc-2', serviceCode: 'CAREGIVER', scheduleHours: 0 })]}
      servicesRedacted={over.servicesRedacted ?? false}
      patientDiagnoses={over.patientDiagnoses ?? DIAGS}
      catalogs={over.catalogs ?? CATALOGOS}
      fieldClass={over.fieldClass ?? FIELD_CLASS}
      responsibles={over.responsibles ?? [RESPONSAVEL]}
      externalContacts={over.externalContacts ?? [EXTERNO]}
      coverageEmergencyContacts={over.coverageEmergencyContacts ?? [COBERTURA]}
      professionals={over.professionals ?? [PROFISSIONAL]}
      from={over.from ?? null}
      initialContactStatus={over.initialContactStatus ?? []}
      saving={over.saving ?? false}
      saveError={over.saveError ?? null}
      saveBlockError={over.saveBlockError ?? null}
      onSubmit={over.onSubmit ?? onSubmit}
      onCancel={over.onCancel ?? onCancel}
      onDirty={over.onDirty ?? onDirty}
      catalogGateway={over.catalogGateway ?? (fake as unknown as TherapeuticCatalogGateway)}
    />,
  );

// ── Helpers de interação (o operador, não a prop) ────────────────────────────

const salvar = () => screen.getByTestId('tp-save') as HTMLButtonElement;

/** A lista aberta do Combobox real (o `id` é do GATILHO; o `ul[role=listbox]` mora no pai dele), abrindo-o se estiver fechado. */
function listaDoMulti(id: string): HTMLElement {
  const gatilho = document.getElementById(id)!;
  if (gatilho.getAttribute('aria-expanded') !== 'true') fireEvent.click(gatilho);
  return gatilho.parentElement!.querySelector('ul[role="listbox"]') as HTMLElement;
}

/** Marca/desmarca a opção com aquele rótulo no Combobox real (o operador clicando, não a prop). */
function alternarNoMulti(id: string, label: string): void {
  const alvo = within(listaDoMulti(id)).getByText(label);
  fireEvent.click(alvo.closest('button')!);
}

/** Escolhe o rótulo num Combobox de escolha única (id = do gatilho): o operador abrindo e clicando. */
function escolherNoCombo(id: string, label: string): void {
  alternarNoMulti(id, label);
}

/** Passos 3 e 4 do bloco de A como o operador: espera o bloco, marca o objetivo um e a atividade um. */
async function escolherPlanoDeA(): Promise<void> {
  fireEvent.click(await screen.findByTestId(`tp-obj-${A_URI}-${objA(A_URI)}`));
  fireEvent.click(screen.getByTestId(`tp-act-${A_URI}-${objA(A_URI)}-${A_URI}-a1`));
}

async function preencherTudo(): Promise<void> {
  escolherNoCombo('tp-modality', 'Híbrida'); // HYBRID = Híbrida
  fireEvent.click(screen.getByTestId('icd-pick-a'));
  fireEvent.change(screen.getByTestId('tp-clinicalContext'), { target: { value: '  contexto clínico  ' } });
  fireEvent.change(screen.getByTestId('tp-generalObjective'), { target: { value: '  objetivo geral  ' } });
  await escolherPlanoDeA();
  fireEvent.change(screen.getByTestId('tp-startDate'), { target: { value: '2026-09-01' } });
  fireEvent.change(screen.getByTestId('tp-endDate'), { target: { value: '2026-12-01' } });
}

beforeEach(() => {
  fake = new FakeGateway();
  onSubmit.mockReset();
  onCancel.mockReset();
  onDirty.mockReset();
});

// ── Modo "Novo" ──────────────────────────────────────────────────────────────

describe('modo "Novo" — versão do zero', () => {
  it('pré-preenche o CID com os diagnósticos ATIVOS do cadastro (o inativo fica fora)', () => {
    montar();

    const chips = screen.getAllByTestId('tp-diagnosis-chip');
    expect(chips.map((c) => c.textContent)).toEqual(['Diagnóstico A', 'Diagnóstico C']);
    expect(screen.queryByText('Diagnóstico INATIVO')).not.toBeInTheDocument();
  });

  it('serviço: pré-seleciona o primeiro ATIVO e rotula com as horas quando existem', () => {
    montar();

    expect(screen.getByTestId('tp-service')).toHaveTextContent('Acompanhante Terapêutico · 20 h/sem'); // svc-1
    const opcoes = Array.from(listaDoMulti('tp-service').querySelectorAll('li[role="option"]')).map((o) => o.textContent);
    expect(opcoes).toContain('Acompanhante Terapêutico · 20 h/sem');
    expect(opcoes).toContain('Cuidador'); // `scheduleHours: 0` → sem o sufixo
    expect(screen.queryByTestId('tp-no-service')).not.toBeInTheDocument();
  });

  it('serviço INATIVO não entra na lista de escolha', () => {
    montar({ services: [servico(), servico({ id: 'svc-morto', active: false, serviceCode: 'CAREGIVER' })] });

    expect(Array.from(listaDoMulti('tp-service').querySelectorAll('li[role="option"]'))).toHaveLength(1); // só svc-1, o inativo fica fora
  });

  it('🔴 sem NENHUM serviço ativo: aviso âmbar e "Salvar" travado (não há o que vincular)', () => {
    montar({ services: [servico({ active: false })] });

    expect(screen.getByTestId('tp-no-service')).toHaveTextContent(tf('noActiveService'));
    expect(screen.getByTestId('tp-service')).toHaveTextContent(tf('servicePlaceholder'));
    expect(salvar().disabled).toBe(true);
  });

  // D113 (achado do gate, 14/09): `services=[]` por REDAÇÃO (sem `patient_services:read`) NÃO é
  // "o paciente não tem serviço ativo" — o form tem de dizer a coisa certa.
  it('🔴 D113: `services=[]` REDIGIDO (sem a célula) mostra "sem permissão", NUNCA "precisa de serviço"', () => {
    montar({ services: [], servicesRedacted: true });

    expect(screen.getByTestId('tp-service-redacted')).toHaveTextContent(tc('redacted'));
    expect(screen.queryByTestId('tp-no-service')).not.toBeInTheDocument();
  });

  it('trocar o serviço marca o formulário como sujo', () => {
    montar();

    escolherNoCombo('tp-service', 'Cuidador'); // svc-2 = Cuidador (weeklyHours null: sem sufixo)

    expect(screen.getByTestId('tp-service')).toHaveTextContent('Cuidador');
    expect(onDirty).toHaveBeenCalled();
  });
});

// ── CID: chips ───────────────────────────────────────────────────────────────

describe('chips de CID', () => {
  it('acrescenta o escolhido no combobox', () => {
    montar({ patientDiagnoses: [] });

    fireEvent.click(screen.getByTestId('icd-pick-b'));

    expect(screen.getAllByTestId('tp-diagnosis-chip').map((c) => c.textContent)).toEqual(['Diagnóstico B']);
    expect(onDirty).toHaveBeenCalledTimes(1);
  });

  it('🔴 escolher o MESMO CID duas vezes não duplica o chip (nem marca sujo de novo)', () => {
    montar({ patientDiagnoses: [] });

    fireEvent.click(screen.getByTestId('icd-pick-a'));
    fireEvent.click(screen.getByTestId('icd-pick-a'));

    expect(screen.getAllByTestId('tp-diagnosis-chip')).toHaveLength(1);
    expect(onDirty).toHaveBeenCalledTimes(1);
  });

  it('remover o chip pelo "x" tira o diagnóstico e marca sujo', () => {
    montar({ patientDiagnoses: [] });
    fireEvent.click(screen.getByTestId('icd-pick-a'));
    fireEvent.click(screen.getByTestId('icd-pick-b'));

    fireEvent.click(screen.getByLabelText('Remover Diagnóstico A'));

    expect(screen.getAllByTestId('tp-diagnosis-chip').map((c) => c.textContent)).toEqual(['Diagnóstico B']);
  });

  it('remover TODOS os chips trava o "Salvar" (CID é obrigatório)', async () => {
    montar({ patientDiagnoses: [] });
    await preencherTudo();
    expect(salvar().disabled).toBe(false);

    fireEvent.click(screen.getByLabelText('Remover Diagnóstico A'));

    expect(salvar().disabled).toBe(true);
  });
});

// ── Validação: cada regra trava o botão ──────────────────────────────────────

describe('"Salvar" fica travado até TODA regra passar', () => {
  it('formulário recém-aberto (sem texto, sem catálogo, sem fim) já nasce travado', () => {
    montar();

    expect(salvar().disabled).toBe(true);
  });

  it.each([
    ['contexto clínico só com espaço', () => fireEvent.change(screen.getByTestId('tp-clinicalContext'), { target: { value: '   ' } })],
    ['objetivo geral só com espaço', () => fireEvent.change(screen.getByTestId('tp-generalObjective'), { target: { value: '   ' } })],
    ['objetivo desmarcado (leva as atividades junto)', () => fireEvent.click(screen.getByTestId(`tp-obj-${A_URI}-${objA(A_URI)}`))],
    ['atividade desmarcada', () => fireEvent.click(screen.getByTestId(`tp-act-${A_URI}-${objA(A_URI)}-${A_URI}-a1`))],
    ['data de início apagada', () => fireEvent.change(screen.getByTestId('tp-startDate'), { target: { value: '' } })],
    ['data de término apagada', () => fireEvent.change(screen.getByTestId('tp-endDate'), { target: { value: '' } })],
  ])('%s → continua travado', async (_nome, quebrar) => {
    montar({ patientDiagnoses: [] });
    await preencherTudo();
    expect(salvar().disabled).toBe(false);

    quebrar(); // desmarca/apaga o campo que preencherTudo tinha deixado válido

    expect(salvar().disabled).toBe(true);
  });

  it('🔴 término ANTES do início: mensagem de erro no campo e botão travado', async () => {
    montar({ patientDiagnoses: [] });
    await preencherTudo();

    fireEvent.change(screen.getByTestId('tp-endDate'), { target: { value: '2026-08-01' } });

    expect(screen.getByText(tf('endBeforeStart'))).toBeInTheDocument();
    expect(salvar().disabled).toBe(true);
  });

  it('término igual ao início é válido (a mensagem some)', async () => {
    montar({ patientDiagnoses: [] });
    await preencherTudo();

    fireEvent.change(screen.getByTestId('tp-endDate'), { target: { value: '2026-09-01' } });

    expect(screen.queryByText(tf('endBeforeStart'))).not.toBeInTheDocument();
    expect(salvar().disabled).toBe(false);
  });

  it('D301 — modalidade: obrigatória (sem ela "Salvar" trava), 3 opções traduzidas; versão antiga com `null` abre vazia e exige escolha', async () => {
    montar({ patientDiagnoses: [] });
    await preencherTudo();
    expect(salvar().disabled).toBe(false);
    cleanup();
    montar({ patientDiagnoses: [] });
    const opcoes = Array.from(listaDoMulti('tp-modality').querySelectorAll('li[role="option"]')).map((o) => o.textContent);
    expect(opcoes).toEqual(['Presencial', 'On-line', 'Híbrida']); // IN_PERSON, ONLINE, HYBRID — sem linha de limpar
    expect(opcoes).toContain(ptBR.admin.patients.detail.therapeuticProjectCard.modalityOptions.ONLINE);
    cleanup();
    montar({ from: { ...VERSAO, modality: null } });
    expect(screen.getByTestId('tp-modality')).toHaveTextContent(tf('modalityPlaceholder'));
    expect(salvar().disabled).toBe(true);
    escolherNoCombo('tp-modality', 'On-line'); // ONLINE = On-line
    expect(salvar().disabled).toBe(false);
  });

  it('`saving` trava o botão, troca o rótulo, desabilita "Cancelar" e o combobox de CID', () => {
    montar({ saving: true });

    expect(salvar().disabled).toBe(true);
    expect(salvar()).toHaveTextContent(tf('saving'));
    expect((screen.getByText(ptBR.common.cancel).closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('icd-stub').getAttribute('data-disabled')).toBe('true');
  });
});

// ── Submissão ────────────────────────────────────────────────────────────────

describe('submissão', () => {
  it('manda o corpo com os textos em `trim` e sem `major`/`minor` (a numeração é do servidor)', async () => {
    montar({ patientDiagnoses: [] });
    await preencherTudo();

    fireEvent.click(salvar());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      contractedServiceId: 'svc-1',
      modality: 'HYBRID',
      diagnoses: [{ uri: 'urn:icd:A', title: 'Diagnóstico A' }],
      clinicalContext: 'contexto clínico',
      generalObjective: 'objetivo geral',
      diagnosisPlans: [{ diagnosisUri: A_URI, specificObjectiveIds: [objA(A_URI)], activityIds: [`${A_URI}-a1`] }],
      startDate: '2026-09-01',
      endDate: '2026-12-01',
      contactRefs: [],
      careTeamIds: [],
      contactStatus: {},
    });
    expect(Object.keys(onSubmit.mock.calls[0][0])).not.toContain('major');
    // 091: o segmento saiu do corpo, e a lista plana também (o "Nuevo" é sempre por diagnóstico).
    expect(Object.keys(onSubmit.mock.calls[0][0])).not.toContain('segmentId');
    expect(Object.keys(onSubmit.mock.calls[0][0])).not.toContain('specificObjectiveIds');
    // O tipo de patologia não é escolhido: deriva do CID-11 no servidor (Gabriel 08/09) — nem campo, nem chave no corpo.
    expect(Object.keys(onSubmit.mock.calls[0][0])).not.toContain('pathologyTypeIds');
    expect(screen.queryByTestId('tp-pathologyTypes')).not.toBeInTheDocument();
  });

  it('🔴 `submit` do formulário com regra pendente NÃO chama `onSubmit` (a trava não é só o `disabled`)', () => {
    montar();

    fireEvent.submit(screen.getByTestId('therapeutic-project-form'));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('"Cancelar" chama `onCancel`', () => {
    montar();

    fireEvent.click(screen.getByText(ptBR.common.cancel));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('a recusa do servidor aparece no bloco de erro do formulário', () => {
    montar({ saveError: 'O serviço escolhido não é deste paciente.' });

    expect(screen.getByTestId('tp-form-error')).toHaveTextContent('O serviço escolhido não é deste paciente.');
    expect(screen.getByTestId('tp-form-error').getAttribute('role')).toBe('alert');
  });
});

// ── Modo "Editar" ────────────────────────────────────────────────────────────

describe('modo "Editar" — os campos nascem da versão de origem', () => {
  it('serviço, CID, textos, catálogos e prazos vêm da versão (não do cadastro) — MACRO travado (D328) renderiza como TEXTO', () => {
    montar({ from: VERSAO });

    // MACRO travado (D328/R5): TEXTO, nunca `<select>`/`<textarea>`.
    expect(screen.queryByTestId('tp-service')).not.toBeInTheDocument();
    expect(screen.getByTestId('tp-service-locked')).toHaveTextContent('Cuidador');
    expect(screen.getAllByTestId('tp-diagnosis-chip').map((c) => c.textContent)).toEqual(['Diagnóstico B']);
    expect(screen.queryByTestId('tp-clinicalContext')).not.toBeInTheDocument();
    expect(screen.getByTestId('tp-clinicalContext-locked')).toHaveTextContent('contexto de origem');
    expect(screen.queryByTestId('tp-generalObjective')).not.toBeInTheDocument();
    expect(screen.getByTestId('tp-generalObjective-locked')).toHaveTextContent('objetivo de origem');
    // MICRO (startDate/endDate) continua editável, mesmo em modo Editar.
    expect((screen.getByTestId('tp-startDate') as HTMLInputElement).value).toBe('2026-01-10');
    expect((screen.getByTestId('tp-endDate') as HTMLInputElement).value).toBe('2026-06-10');
    expect(salvar().disabled).toBe(false);
  });

  it('🔒 `optionsOf` (fieldClass sem macro, isola o merge catálogo+snapshot): item do snapshot que já NÃO está ativo no catálogo continua como opção', () => {
    montar({ from: VERSAO, fieldClass: FIELD_CLASS_SEM_MACRO });

    const lista = listaDoMulti('tp-specificObjectives');

    // o catálogo vivo tem Objetivo 1 e 2; o snapshot tem `so-morto`, que precisa aparecer também
    expect(within(lista).getByText('Objetivo DESATIVADO no catálogo')).toBeInTheDocument();
    expect(within(lista).getByText('Objetivo 1')).toBeInTheDocument();
    expect(lista.querySelectorAll('li[role="option"]')).toHaveLength(3);
  });

  it('item do snapshot que AINDA está no catálogo não é duplicado (fieldClass sem macro)', () => {
    montar({ from: VERSAO, fieldClass: FIELD_CLASS_SEM_MACRO });

    expect(listaDoMulti('tp-activities').querySelectorAll('li[role="option"]')).toHaveLength(1);
  });

  it('versão de origem sem CID (`diagnoses: null`) cai no CID ativo do cadastro', () => {
    montar({ from: { ...VERSAO, diagnoses: null } });

    expect(screen.getAllByTestId('tp-diagnosis-chip').map((c) => c.textContent)).toEqual(['Diagnóstico A', 'Diagnóstico C']);
  });

  it('salvar a partir da origem manda o corpo da versão de origem (com o item desativado dentro, mesmo travado na tela)', () => {
    montar({ from: VERSAO });

    fireEvent.click(salvar());

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      contractedServiceId: 'svc-2',
      modality: 'IN_PERSON',
      specificObjectiveIds: ['so-morto'],
      startDate: '2026-01-10',
      endDate: '2026-06-10',
      contactRefs: [],
      careTeamIds: [],
    }));
  });
});

// ── D328/ADR-4 — MACRO trava só na EDIÇÃO da vigente; "Novo" nunca trava ────

describe('🔒 D328/ADR-4 — campo MACRO trava na edição, nunca vira input desabilitado', () => {
  it('"Editar" com `fieldClass` da API: nenhum input/select/textarea `disabled` no formulário (a lista some do DOM, não fica cinza)', () => {
    montar({ from: VERSAO });

    // A prova da regra "nunca input disabled/readOnly": nenhum elemento de formulário desabilitado existe.
    expect(document.querySelectorAll('input:disabled, textarea:disabled, select:disabled')).toHaveLength(0);
    expect(document.querySelectorAll('input[readonly], textarea[readonly]')).toHaveLength(0);
  });

  it('"Novo" (`from: null`) nunca trava, mesmo com a MESMA lista `fieldClass` que travaria na edição', () => {
    montar({ from: null, fieldClass: FIELD_CLASS });

    expect(screen.getByTestId('tp-service')).toBeInTheDocument();
    expect(screen.queryByTestId('tp-service-locked')).not.toBeInTheDocument();
    expect(screen.getByTestId('tp-clinicalContext')).toBeInTheDocument();
    expect(screen.getByTestId('tp-generalObjective')).toBeInTheDocument();
  });

  it('`fieldClass.macro` vazio: "Editar" não trava NENHUM campo, mesmo sendo `from !== null`', () => {
    montar({ from: VERSAO, fieldClass: { macro: [], micro: FIELD_CLASS.micro } });

    expect(screen.getByTestId('tp-service')).toBeInTheDocument();
    expect(screen.getByTestId('tp-clinicalContext')).toBeInTheDocument();
    expect(screen.getByTestId('tp-generalObjective')).toBeInTheDocument();
  });

  it('CID travado: some o combobox e o "x" de remover, mas o chip continua visível', () => {
    montar({ from: VERSAO });

    expect(screen.queryByTestId('icd-stub')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Remover Diagnóstico B')).not.toBeInTheDocument();
    expect(screen.getByText('Diagnóstico B')).toBeInTheDocument();
  });

  it('lista MACRO travada VAZIA (nenhum objetivo/atividade na versão de origem) mostra "—", não uma lista vazia muda', () => {
    montar({ from: { ...VERSAO, specificObjectives: [], activities: [] } });

    expect(screen.getByTestId('tp-specificObjectives-locked')).toHaveTextContent('—');
    expect(screen.getByTestId('tp-activities-locked')).toHaveTextContent('—');
  });

  it('spec 060: atividades travadas (MACRO) saem A–Z, sem mudar a versão de origem', () => {
    const atividades = [item('ac1', 'Zeta actividad'), item('ac2', 'Árbol actividad'), item('ac3', 'Abeja actividad')];
    montar({ from: { ...VERSAO, activities: atividades } });

    const lis = Array.from(screen.getByTestId('tp-activities-locked').querySelectorAll('li')).map((li) => li.textContent);
    expect(lis).toEqual(['Abeja actividad', 'Árbol actividad', 'Zeta actividad']);
    expect(atividades.map((a) => a.id)).toEqual(['ac1', 'ac2', 'ac3']);
  });

  it('serviço travado cujo id não existe em `services` (removido/de outro paciente): cai no id cru, não quebra', () => {
    montar({ from: { ...VERSAO, contractedServiceId: 'svc-removido' } });

    expect(screen.getByTestId('tp-service-locked')).toHaveTextContent('svc-removido');
  });

  // D113 (achado do gate 14/09): editar SEM `patient_services:read` — o Drawer manda `services=[]`
  // (redação) e o MACRO trava `contractedServiceId` como texto (D328). ANTES do conserto, o texto
  // travado vazava o UUID cru (`from.contractedServiceId`) como se fosse o rótulo do serviço — o
  // mesmo tipo de mentira que `tp-no-service` seria, só que no ramo travado em vez do `<select>`.
  it('🔴 D113 editar: `services=[]` REDIGIDO mostra "sem permissão" no lugar do serviço, NUNCA o UUID cru', () => {
    montar({ from: VERSAO, services: [], servicesRedacted: true });

    expect(screen.getByTestId('tp-service-locked')).toHaveTextContent(tc('redacted'));
    expect(screen.getByTestId('tp-service-locked')).not.toHaveTextContent(VERSAO.contractedServiceId);
  });

  // O `contractedServiceId` em si (o que o POST manda) NUNCA pode se perder por causa da redação —
  // ele vem de `from`, não de `services`. Prova indireta: salvar com os outros campos válidos e
  // conferir o corpo enviado a `onSubmit`.
  it('🔴 D113 editar: `services=[]` REDIGIDO não perde o `contractedServiceId` que vem de `from` (o POST manda o id certo)', () => {
    montar({ from: VERSAO, services: [], servicesRedacted: true });

    fireEvent.submit(screen.getByTestId('therapeutic-project-form'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ contractedServiceId: VERSAO.contractedServiceId }));
  });

  it('editar COM a célula (`servicesRedacted` ausente/false) e serviço encontrado: comportamento INALTERADO — mostra o rótulo do serviço', () => {
    montar({ from: VERSAO });

    expect(screen.getByTestId('tp-service-locked')).toHaveTextContent('Cuidador');
    expect(screen.queryByTestId('tp-service-redacted')).not.toBeInTheDocument();
  });
});

// ── Contatos por seleção (PR-7, MICRO — sempre editável) ────────────────────

describe('contatos por seleção (task 7.7): responsáveis, externos, cobertura, equipe tratante', () => {
  it('as 4 listas mostram só os itens recebidos (já ativos — o servidor filtra, D286)', () => {
    montar();

    expect(within(listaDoMulti('tp-responsibles')).getByText('Marta Gómez')).toBeInTheDocument();
    expect(within(listaDoMulti('tp-externalContacts')).getByText('Lucía Externa')).toBeInTheDocument();
    expect(within(listaDoMulti('tp-coverageContacts')).getByText(/Emergencias ACME/)).toBeInTheDocument();
    expect(within(listaDoMulti('tp-careTeam')).getByText('Dr. Fulano')).toBeInTheDocument();
  });

  it('marcar um responsável, um externo, um de cobertura e um da equipe monta `contactRefs`/`careTeamIds` no envio', async () => {
    montar({ patientDiagnoses: [] });
    await preencherTudo();

    alternarNoMulti('tp-responsibles', 'Marta Gómez');
    alternarNoMulti('tp-externalContacts', 'Lucía Externa');
    alternarNoMulti('tp-coverageContacts', 'Emergencias ACME · Emergência da cobertura/plano');
    alternarNoMulti('tp-careTeam', 'Dr. Fulano');

    fireEvent.click(salvar());

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      contactRefs: [
        { kind: 'RESPONSIBLE', id: 'resp-1' },
        { kind: 'EXTERNAL', id: 'ext-1' },
        { kind: 'COVERAGE', id: 'cov-1' },
      ],
      careTeamIds: ['prof-1'],
    }));
  });

  it('marcar um contato chama `onDirty` (é MICRO, sempre editável, inclusive travado o resto)', () => {
    montar({ from: VERSAO });

    alternarNoMulti('tp-responsibles', 'Marta Gómez');

    expect(onDirty).toHaveBeenCalled();
  });

  it('"Editar" nasce com os `contactRefs`/`careTeamIds` da versão de origem, não em branco (contato ATIVO, `contacts` resolvido)', () => {
    montar({
      from: {
        ...VERSAO,
        contactRefs: [{ kind: 'RESPONSIBLE', id: 'resp-1' }, { kind: 'COVERAGE', id: 'cov-1' }],
        careTeamIds: ['prof-1'],
        contacts: [
          { kind: 'RESPONSIBLE', id: 'resp-1', name: 'Marta Gómez', phone: '111' },
          { kind: 'COVERAGE', id: 'cov-1', name: 'Emergencias ACME', phone: '333' },
          { kind: 'CARE_TEAM', id: 'prof-1', name: 'Dr. Fulano', phone: null },
        ],
      },
    });

    const respostas = within(listaDoMulti('tp-responsibles')).getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(respostas.map((o) => o.textContent)).toEqual(['Marta Gómez']);
    expect(screen.queryByTestId('tp-form-contact-removed')).not.toBeInTheDocument();
  });

  // Conserto 14/09 (achado do gate, decisão do Gabriel): editar a vigente NÃO reconstrói a seleção
  // de contato inativo (a versão antiga fica intocada — só a minor nova exclui); contato ativo e
  // REDIGIDO (sem célula de origem) fica mantido — "não some".
  describe('conserto 14/09 — contato inativo sai da seleção ao editar, com aviso; redigido é mantido', () => {
    it('contato INATIVO em `from.contacts` (`inactive:true`) NÃO entra pré-marcado, e o aviso lista o kind/contagem', () => {
      montar({
        from: {
          ...VERSAO,
          contactRefs: [{ kind: 'RESPONSIBLE', id: 'resp-1' }],
          careTeamIds: ['prof-1'],
          contacts: [
            { kind: 'RESPONSIBLE', id: 'resp-1', inactive: true },
            { kind: 'CARE_TEAM', id: 'prof-1', inactive: true },
          ],
        },
      });

      const respostas = within(listaDoMulti('tp-responsibles')).getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
      expect(respostas).toHaveLength(0);
      const equipe = within(listaDoMulti('tp-careTeam')).getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
      expect(equipe).toHaveLength(0);
      const aviso = screen.getByTestId('tp-form-contact-removed').textContent ?? '';
      expect(aviso).toContain('Responsáveis (1)');
      expect(aviso).toContain('Equipe tratante (1)');
    });

    it('contato ATIVO mas REDIGIDO (`redacted:true`, sem célula de origem) fica MANTIDO na seleção — não some', () => {
      montar({
        from: {
          ...VERSAO,
          contactRefs: [{ kind: 'COVERAGE', id: 'cov-1' }],
          careTeamIds: [],
          contacts: [{ kind: 'COVERAGE', id: 'cov-1', redacted: true }],
        },
      });

      const cobertura = within(listaDoMulti('tp-coverageContacts')).getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
      expect(cobertura.map((o) => o.textContent)).toEqual([expect.stringContaining('Emergencias ACME')]);
      expect(screen.queryByTestId('tp-form-contact-removed')).not.toBeInTheDocument();
    });

    it('ref sem NENHUMA entrada em `from.contacts` (anomalia de dado) também sai — trata como inativo, nunca quebra', () => {
      montar({
        from: { ...VERSAO, contactRefs: [{ kind: 'EXTERNAL', id: 'ext-1' }], careTeamIds: [], contacts: [] },
      });

      const externos = within(listaDoMulti('tp-externalContacts')).getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
      expect(externos).toHaveLength(0);
      expect(screen.getByTestId('tp-form-contact-removed').textContent).toContain('Contatos externos');
    });

    it('COVERAGE inativo também entra no aviso, com o rótulo do container de cobertura', () => {
      montar({
        from: { ...VERSAO, contactRefs: [{ kind: 'COVERAGE', id: 'cov-1' }], careTeamIds: [], contacts: [{ kind: 'COVERAGE', id: 'cov-1', inactive: true }] },
      });

      const cobertura = within(listaDoMulti('tp-coverageContacts')).getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
      expect(cobertura).toHaveLength(0);
      expect(screen.getByTestId('tp-form-contact-removed').textContent).toContain('Contatos da cobertura (1)');
    });

    it('"Novo" (`from === null`) nunca mostra o aviso — não há origem pra perder contato', () => {
      montar();
      expect(screen.queryByTestId('tp-form-contact-removed')).not.toBeInTheDocument();
    });
  });

  it('"Novo" começa em branco: nenhum contato pré-marcado', () => {
    montar();

    const opcoes = within(listaDoMulti('tp-responsibles')).getAllByRole('option');
    expect(opcoes.every((o) => o.getAttribute('aria-selected') !== 'true')).toBe(true);
  });

  it('rótulo do responsável cai pra `relationship` sem nome, e pro `id` sem nome nem relationship', () => {
    montar({
      responsibles: [
        { ...RESPONSAVEL, id: 'r-so-relacao', firstName: null, lastName: null, relationship: 'FATHER' },
        { ...RESPONSAVEL, id: 'r-sem-nada', firstName: null, lastName: null, relationship: null },
      ],
    });

    const lista = listaDoMulti('tp-responsibles');
    expect(within(lista).getByText('FATHER')).toBeInTheDocument();
    expect(within(lista).getByText('r-sem-nada')).toBeInTheDocument();
  });

  it('rótulo do profissional cai pro texto de "não encontrado" quando `name` é `null`', () => {
    montar({ professionals: [{ ...PROFISSIONAL, name: null }] });

    expect(within(listaDoMulti('tp-careTeam')).getByText(ptBR.admin.patients.detail.therapeuticProjectCard.serviceUnknown)).toBeInTheDocument();
  });
});

// ── 091 — cascata do "Nuevo" (§9.8, DF-6, DD-13, DD-21) ─────────────────────

const objCheck = (uri: string, id: string) => screen.getByTestId(`tp-obj-${uri}-${id}`) as HTMLInputElement;
const actChecks = (uri: string) => Array.from(screen.getByTestId(`tp-activities-${uri}`).querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
const aguardarBlocos = (n: number) => waitFor(() => expect(screen.getAllByTestId(/^tp-block-urn/)).toHaveLength(n));

describe('091 — "Nuevo": passos habilitam em ordem', () => {
  it('Paso 1 e Paso 2 têm os textos da cascata e o segmento não existe mais', async () => {
    montar();
    await aguardarBlocos(2);

    expect(screen.getByText(ptBR.therapeuticProjectForm.stepService)).toBeInTheDocument();
    expect(screen.getByText(ptBR.therapeuticProjectForm.stepDiagnoses)).toBeInTheDocument();
    expect(screen.queryByTestId('tp-segment')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tp-segment-locked')).not.toBeInTheDocument();
  });

  it('Paso 2 desabilitado sem serviço (`chooseServiceFirst`) e a cascata NÃO é chamada', () => {
    montar({ services: [] });

    expect(screen.getByTestId('icd-stub').getAttribute('data-disabled')).toBe('true');
    expect(screen.getByTestId('tp-choose-service-first')).toHaveTextContent(ptBR.therapeuticProjectForm.chooseServiceFirst);
    expect(fake.calls).toHaveLength(0);
  });

  it('com serviço o Paso 2 habilita e a cascata é chamada com o CÓDIGO do serviço e as URIs, na ordem', async () => {
    montar();
    await aguardarBlocos(2);

    expect(screen.getByTestId('icd-stub').getAttribute('data-disabled')).toBe('false');
    expect(screen.queryByTestId('tp-choose-service-first')).not.toBeInTheDocument();
    expect(fake.calls).toEqual([{ serviceCode: 'AT', diagnosisUris: [A_URI, C_URI] }]);
    expect(screen.getAllByTestId(/^tp-block-title-/).map((e) => e.textContent)).toEqual(['Diagnóstico A', 'Diagnóstico C']);
  });

  it('DD-13: "Nuevo" nasce SEM objetivo nem atividade marcados, e o Paso 4 espera um objetivo (`pickObjectiveFirst`)', async () => {
    montar();
    await aguardarBlocos(2);

    expect(objCheck(A_URI, objA(A_URI)).checked).toBe(false);
    expect(actChecks(A_URI)).toHaveLength(0);
    expect(screen.getByTestId(`tp-pick-objective-${A_URI}`)).toHaveTextContent(ptBR.therapeuticProjectForm.pickObjectiveFirst);
    expect(screen.getByTestId(`tp-activities-${A_URI}`)).toBeDisabled();
  });

  it('marcar o objetivo habilita o Paso 4, agrupa as atividades dele e mostra título, descrição e frecuencia', async () => {
    montar();
    await aguardarBlocos(2);

    fireEvent.click(objCheck(A_URI, objA(A_URI)));

    const grupo = screen.getByTestId(`tp-activity-group-${A_URI}-${objA(A_URI)}`);
    expect(screen.getByTestId(`tp-activities-${A_URI}`)).not.toBeDisabled();
    expect(within(grupo).getByText('Atividade um')).toBeInTheDocument();
    expect(within(grupo).getByText('Descrição da atividade um')).toBeInTheDocument();
    expect(within(grupo).getByText('Frequência: 2x por semana')).toBeInTheDocument();
    expect(within(grupo).getAllByTestId('tp-activity-frequency')).toHaveLength(1); // a atividade sem frecuencia não mostra a linha
    expect(actChecks(A_URI)).toHaveLength(2); // as do objetivo dois (não marcado) NÃO aparecem
    expect(onDirty).toHaveBeenCalled();
  });

  it('desmarcar o objetivo tira as atividades dele (e a marcação delas)', async () => {
    montar();
    await aguardarBlocos(2);
    fireEvent.click(objCheck(A_URI, objA(A_URI)));
    fireEvent.click(actChecks(A_URI)[0]);
    expect(actChecks(A_URI)[0].checked).toBe(true);

    fireEvent.click(objCheck(A_URI, objA(A_URI)));
    expect(actChecks(A_URI)).toHaveLength(0);
    fireEvent.click(objCheck(A_URI, objA(A_URI))); // remarcar: a atividade NÃO volta marcada

    expect(actChecks(A_URI).every((c) => !c.checked)).toBe(true);
  });

  it('tirar um diagnóstico some com o bloco dele', async () => {
    montar();
    await aguardarBlocos(2);

    fireEvent.click(screen.getByLabelText('Remover Diagnóstico C'));

    await waitFor(() => expect(screen.queryByTestId(`tp-block-${C_URI}`)).not.toBeInTheDocument());
    expect(screen.getByTestId(`tp-block-${A_URI}`)).toBeInTheDocument();
  });
});

describe('091 — "Nuevo": trocar o serviço zera todos os blocos', () => {
  it('trocar o serviço refaz a cascata e devolve os blocos SEM seleção; o salvar trava de novo', async () => {
    montar({ patientDiagnoses: [DIAGS[0]] });
    await preencherTudo();
    expect(salvar().disabled).toBe(false);

    escolherNoCombo('tp-service', 'Cuidador');

    await waitFor(() => expect(fake.calls.map((c) => c.serviceCode)).toEqual(['AT', 'CAREGIVER']));
    await waitFor(() => expect(objCheck(A_URI, objA(A_URI)).checked).toBe(false));
    expect(actChecks(A_URI)).toHaveLength(0);
    expect(salvar().disabled).toBe(true);
  });
});

describe('091 — bloco sem catálogo e `planIncomplete`', () => {
  it('bloco `no_catalog`: aviso `noCatalog` e nenhuma escolha possível', async () => {
    montar();
    await aguardarBlocos(2);

    expect(screen.getByTestId(`tp-no-catalog-${C_URI}`)).toHaveTextContent(ptBR.therapeuticProjectForm.noCatalog);
    expect(within(screen.getByTestId(`tp-block-${C_URI}`)).queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('o bloco sem catálogo NÃO impede salvar, e sai no corpo vazio, na ordem dos diagnósticos', async () => {
    montar();
    await preencherTudo();
    fireEvent.click(screen.getByTestId('icd-pick-b')); // B entra depois de A e C: 3 blocos
    await waitFor(() => expect(screen.getAllByTestId(/^tp-block-urn/)).toHaveLength(3));
    // B (com catálogo) ainda não foi escolhido: trava; completando B, destrava.
    expect(salvar().disabled).toBe(true);
    fireEvent.click(objCheck('urn:icd:B', objA('urn:icd:B')));
    fireEvent.click(screen.getByTestId(`tp-act-urn:icd:B-${objA('urn:icd:B')}-urn:icd:B-a2`));
    expect(salvar().disabled).toBe(false);
    fireEvent.click(salvar());

    expect(onSubmit.mock.calls[0][0].diagnosisPlans).toEqual([
      { diagnosisUri: A_URI, specificObjectiveIds: [objA(A_URI)], activityIds: [`${A_URI}-a1`] },
      { diagnosisUri: C_URI, specificObjectiveIds: [], activityIds: [] },
      { diagnosisUri: 'urn:icd:B', specificObjectiveIds: [objA('urn:icd:B')], activityIds: ['urn:icd:B-a2'] },
    ]);
  });

  it('só o objetivo marcado, sem atividade: `planIncomplete` no bloco e o salvar travado; completar tira o aviso', async () => {
    montar({ patientDiagnoses: [DIAGS[0]] });
    await preencherTudo();
    fireEvent.click(actChecks(A_URI)[0]); // desmarca a única atividade
    fireEvent.click(objCheck(A_URI, objA(A_URI))); // desmarca e remarca o objetivo: ainda sem atividade
    fireEvent.click(objCheck(A_URI, objA(A_URI)));

    expect(screen.getByTestId(`tp-plan-incomplete-${A_URI}`)).toHaveTextContent(ptBR.therapeuticProjectForm.planIncomplete);
    expect(salvar().disabled).toBe(true);

    fireEvent.click(actChecks(A_URI)[0]);

    expect(screen.queryByTestId(`tp-plan-incomplete-${A_URI}`)).not.toBeInTheDocument();
    expect(salvar().disabled).toBe(false);
  });

  it('422 de bloco (DD-21): `planIncomplete` aparece NO bloco do `diagnosisIndex` 1 (o 2º), e só nele', async () => {
    montar({ saveBlockError: { diagnosisIndex: 1, message: ptBR.therapeuticProjectForm.planIncomplete } });
    await aguardarBlocos(2); // A (índice 0) e C (índice 1)

    expect(within(screen.getByTestId(`tp-block-${C_URI}`)).getByTestId(`tp-block-refusal-${C_URI}`)).toHaveTextContent(ptBR.therapeuticProjectForm.planIncomplete);
    expect(screen.queryByTestId(`tp-block-refusal-${A_URI}`)).not.toBeInTheDocument();
  });

  it('erro da porta (503 de terminologia, 422…): mensagem na tela e o salvar fica travado', async () => {
    fake.respond = async () => { throw new Error('terminologia fora do ar'); };
    montar({ patientDiagnoses: [DIAGS[0]] });

    // o texto vem do i18n; a mensagem crua do servidor NUNCA vai à tela
    const erro = await screen.findByTestId('tp-cascade-error');
    expect(erro).toHaveTextContent(ptBR.therapeuticProjectForm.cascadeError);
    expect(erro).not.toHaveTextContent('terminologia fora do ar');
    expect(screen.queryByText(/terminologia fora do ar/)).not.toBeInTheDocument();
    expect(salvar().disabled).toBe(true);
  });
});

// ── 091 — "Editar" nos dois formatos: blocos/listas só leitura (DD-21) ──────

const PLANO_A: DiagnosisPlanSnapshot = {
  diagnosisUri: 'urn:icd:B',
  categoryCode: 'AB12',
  objectives: [{ id: 'po1', label: 'Objetivo congelado', description: 'Descrição congelada' }],
  activities: [{ id: 'pa1', label: 'Atividade congelada', description: null, suggestedFrequency: '3x por semana' }],
};
const VERSAO_BY_DIAGNOSIS: TherapeuticProjectVersion = { ...VERSAO, objectivesLayout: 'byDiagnosis', specificObjectives: [], activities: [], diagnosisPlans: [PLANO_A] };

describe('091 — "Editar" nos dois formatos só leitura', () => {
  it('byDiagnosis: blocos só leitura com título, objetivos e atividades congelados; sem checkbox e sem chamar a cascata', async () => {
    montar({ from: VERSAO_BY_DIAGNOSIS });

    const bloco = screen.getByTestId('tp-block-urn:icd:B');
    expect(within(bloco).getByTestId('tp-block-title-urn:icd:B')).toHaveTextContent('Diagnóstico B');
    expect(within(bloco).getByText('Objetivo congelado')).toBeInTheDocument();
    expect(within(bloco).getByText('Frequência: 3x por semana')).toBeInTheDocument();
    expect(within(bloco).queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByTestId('tp-specificObjectives-locked')).not.toBeInTheDocument(); // não é o painel flat
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.calls).toHaveLength(0);
  });

  it('byDiagnosis: salvar manda os ids do snapshot de origem em `diagnosisPlans` (a edição copia o MACRO)', () => {
    montar({ from: VERSAO_BY_DIAGNOSIS });

    fireEvent.click(salvar());

    const corpo = onSubmit.mock.calls[0][0];
    expect(corpo.diagnosisPlans).toEqual([{ diagnosisUri: 'urn:icd:B', specificObjectiveIds: ['po1'], activityIds: ['pa1'] }]);
    expect(Object.keys(corpo)).not.toContain('specificObjectiveIds');
  });

  it('flat: listas de hoje só leitura (texto, nunca input), sem blocos e sem chamar a cascata', async () => {
    montar({ from: { ...VERSAO, specificObjectives: [{ id: 'so1', label: 'Objetivo 1' }] } });

    expect(screen.getByTestId('tp-specificObjectives-locked')).toHaveTextContent('Objetivo 1');
    expect(screen.queryByTestId('tp-diagnosis-blocks')).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.calls).toHaveLength(0);
  });

  it('DD-21: o formato vem de `objectivesLayout`, não de `diagnosisPlans === null` (byDiagnosis redigido segue sendo blocos, vazio)', () => {
    montar({ from: { ...VERSAO_BY_DIAGNOSIS, diagnosisPlans: null, redacted: { clinical: true } } });

    expect(screen.getByTestId('tp-diagnosis-blocks')).toBeInTheDocument();
    expect(screen.queryByTestId('tp-specificObjectives-locked')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^tp-block-urn/)).toHaveLength(0);
  });
});
// ── lex C7: versão redigida ──────────────────────────────────────────────────

describe('🔒 lex C7 — versão redigida não vira versão nova', () => {
  it('mostra o aviso e trava "Salvar" mesmo com o resto preenchido; os textos travados (MACRO) nascem vazios', () => {
    montar({ from: { ...VERSAO, redacted: { clinical: true }, clinicalContext: null, generalObjective: null } });

    expect(screen.getByTestId('tp-form-redacted')).toHaveTextContent(tf('redactedCannotEdit'));
    // Com o `fieldClass` padrão, clinicalContext/generalObjective já são MACRO travado (D328) —
    // vira TEXTO vazio, não textarea. A trava do "Salvar" continua vindo do `clinicalRedacted`.
    expect(screen.getByTestId('tp-clinicalContext-locked')).toHaveTextContent('');
    expect(screen.getByTestId('tp-generalObjective-locked')).toHaveTextContent('');
    expect(salvar().disabled).toBe(true);
  });

  it('com `fieldClass` sem macro (campo NÃO travado por classe), o textarea real nasce desabilitado pelo redigido', () => {
    montar({ from: { ...VERSAO, redacted: { clinical: true }, clinicalContext: null, generalObjective: null }, fieldClass: FIELD_CLASS_SEM_MACRO });

    expect((screen.getByTestId('tp-clinicalContext') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByTestId('tp-clinicalContext') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByTestId('tp-generalObjective') as HTMLTextAreaElement).disabled).toBe(true);
    expect(salvar().disabled).toBe(true);
  });

  it('🔴 nem o `submit` direto passa quando a origem está redigida', () => {
    montar({ from: { ...VERSAO, redacted: { clinical: true } } });

    fireEvent.submit(screen.getByTestId('therapeutic-project-form'));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ── spec 048: estado explícito dos campos de contato no corpo ────────────────

describe('spec 048 — "Todavía no hay registro" / "No necesita" no corpo enviado', () => {
  const marcar = (id: string) => fireEvent.click(screen.getByTestId(id));

  it('marcar "Todavía no hay registro" em 2 campos: o corpo leva PENDING neles e NENHUM id; o resto do corpo é o mesmo', async () => {
    montar({ patientDiagnoses: [] });
    await preencherTudo();
    marcar('tp-responsibles-pending');
    marcar('tp-careTeam-pending');
    fireEvent.click(salvar());

    const corpo = onSubmit.mock.calls[0][0];
    expect(corpo.contactStatus).toEqual({ RESPONSIBLE: 'PENDING', CARE_TEAM: 'PENDING' });
    expect(corpo.contactRefs).toEqual([]);
    expect(corpo.careTeamIds).toEqual([]);
  });

  it('escolher um contato num campo marcado desmarca o estado: o corpo leva o id e NENHUM status naquele campo', async () => {
    montar({ patientDiagnoses: [], initialContactStatus: [{ kind: 'EXTERNAL', status: 'NOT_NEEDED', pendingSince: null, deadlineDate: null }] });
    await preencherTudo();
    alternarNoMulti('tp-externalContacts', 'Lucía Externa');
    fireEvent.click(salvar());
    const corpo = onSubmit.mock.calls[0][0];
    expect(corpo.contactStatus).toEqual({});
    expect(corpo.contactRefs).toEqual([{ kind: 'EXTERNAL', id: 'ext-1' }]);
  });

  it('"Editar" já nasce com o estado herdado da origem (NOT_NEEDED herdado viaja no corpo)', () => {
    montar({
      from: { ...VERSAO, contactStatus: [{ kind: 'COVERAGE', status: 'NOT_NEEDED', pendingSince: null, deadlineDate: null }] },
      initialContactStatus: [{ kind: 'COVERAGE', status: 'NOT_NEEDED', pendingSince: null, deadlineDate: null }],
    });
    escolherNoCombo('tp-modality', 'On-line'); // ONLINE = On-line
    fireEvent.click(salvar());
    expect(onSubmit.mock.calls[0][0].contactStatus).toEqual({ COVERAGE: 'NOT_NEEDED' });
  });

  it('desmarcar o estado e salvar manda o campo SEM status (preencher na versão nova tira o pendente)', () => {
    montar({
      from: VERSAO,
      initialContactStatus: [{ kind: 'CARE_TEAM', status: 'PENDING', pendingSince: '2026-10-01T12:00:00.000Z', deadlineDate: '2026-10-16' }],
    });
    marcar('tp-careTeam-pending');
    escolherNoCombo('tp-modality', 'On-line'); // ONLINE = On-line
    fireEvent.click(salvar());
    expect(onSubmit.mock.calls[0][0].contactStatus).toEqual({});
  });
});

// ── Atividades A–Z e busca — spec 060 ────────────────────────────────────────

describe('campo de atividades de "Editar" flat: A–Z e busca (spec 060)', () => {
  const catalogoDesordenado = (): TherapeuticCatalogs => ({
    'specific-objectives': [item('so2', 'Objetivo 2'), item('so1', 'Objetivo 1')],
    activities: [item('ac1', 'Zeta actividad'), item('ac2', 'Árbol actividad'), item('ac3', 'Abeja actividad')],
  });
  const rotulosDe = (id: string) => Array.from(listaDoMulti(id).querySelectorAll('li')).map((li) => li.textContent);
  const editarFlat = (catalogs: TherapeuticCatalogs) =>
    montar({ from: { ...VERSAO, specificObjectives: [], activities: [] }, fieldClass: FIELD_CLASS_SEM_MACRO, catalogs });

  it('(a) atividades saem A–Z; objetivos seguem a ordem do catálogo', () => {
    editarFlat(catalogoDesordenado());

    expect(rotulosDe('tp-activities')).toEqual(['Abeja actividad', 'Árbol actividad', 'Zeta actividad']);
    expect(rotulosDe('tp-specificObjectives')).toEqual(['Objetivo 2', 'Objetivo 1']);
    expect(screen.queryByTestId('tp-specificObjectives-search')).not.toBeInTheDocument();
  });

  it('(b) digitar "arbol" na busca deixa só "Árbol actividad"', () => {
    editarFlat(catalogoDesordenado());
    listaDoMulti('tp-activities');

    fireEvent.change(screen.getByTestId('tp-activities-search'), { target: { value: 'arbol' } });

    expect(rotulosDe('tp-activities')).toEqual(['Árbol actividad']);
  });

  it('(c) filtrar, marcar a atividade filtrada e salvar leva o id dela em activityIds (além do já marcado)', () => {
    montar({ from: VERSAO, fieldClass: FIELD_CLASS_SEM_MACRO, catalogs: { ...CATALOGOS, // 3 opções: a busca só aparece com >= SEARCH_MIN_OPTIONS (regra do Combobox, não do site)
      activities: [item('ac1', 'Atividade 1'), item('ac2', 'Árbol actividad'), item('ac3', 'Zeta actividad')] } });
    listaDoMulti('tp-activities');
    fireEvent.change(screen.getByTestId('tp-activities-search'), { target: { value: 'arbol' } });
    alternarNoMulti('tp-activities', 'Árbol actividad');
    fireEvent.click(salvar());

    expect(onSubmit.mock.calls[0][0].activityIds).toEqual(['ac1', 'ac2']);
  });
});
