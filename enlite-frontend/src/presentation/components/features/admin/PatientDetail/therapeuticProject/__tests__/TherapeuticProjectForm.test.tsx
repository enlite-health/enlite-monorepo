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
 *
 * `IcdSearchCombobox` é dublê (REQ-21: o código do CID não passa por aqui); `MultiSelect`/`Select`
 * são os REAIS — a régua é o que o operador consegue fazer na tela, não o que a prop aceita.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type {
  PatientContractedServiceDetail,
  PatientCoverageEmergencyContact,
  PatientDiagnosisDetail,
  PatientExternalContactDetail,
  PatientProfessionalDetail,
  PatientResponsibleDetail,
} from '@domain/entities/PatientDetail';
import type { TherapeuticCatalogItem, TherapeuticFieldClass, TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
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

const servico = (over: Partial<PatientContractedServiceDetail> = {}): PatientContractedServiceDetail => ({
  id: 'svc-1',
  patientId: patientDetailFixture.id,
  serviceCode: 'AT',
  professionalProfile: null,
  providersNeeded: 1,
  authorizedHours: 20,
  weeklyHours: 20,
  careLocation: 'HOME',
  hourlyValue: null,
  hourlyValueRedacted: false,
  startDate: null,
  contractType: null,
  taxCondition: null,
  supervisionFrequency: null,
  guardShift: null,
  providerAgeBand: null,
  addressId: null,
  liveVacancyId: null,
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
  segments: [],
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
};

type Props = Parameters<typeof TherapeuticProjectForm>[0];

const onSubmit = vi.fn();
const onCancel = vi.fn();
const onDirty = vi.fn();

const montar = (over: Partial<Props> = {}) =>
  render(
    <TherapeuticProjectForm
      services={over.services ?? [servico(), servico({ id: 'svc-2', serviceCode: 'CAREGIVER', weeklyHours: null })]}
      patientDiagnoses={over.patientDiagnoses ?? DIAGS}
      catalogs={over.catalogs ?? CATALOGOS}
      fieldClass={over.fieldClass ?? FIELD_CLASS}
      responsibles={over.responsibles ?? [RESPONSAVEL]}
      externalContacts={over.externalContacts ?? [EXTERNO]}
      coverageEmergencyContacts={over.coverageEmergencyContacts ?? [COBERTURA]}
      professionals={over.professionals ?? [PROFISSIONAL]}
      from={over.from ?? null}
      saving={over.saving ?? false}
      saveError={over.saveError ?? null}
      onSubmit={over.onSubmit ?? onSubmit}
      onCancel={over.onCancel ?? onCancel}
      onDirty={over.onDirty ?? onDirty}
    />,
  );

// ── Helpers de interação (o operador, não a prop) ────────────────────────────

const salvar = () => screen.getByTestId('tp-save') as HTMLButtonElement;

/** A lista aberta do MultiSelect real (o `ul[role=listbox]`), abrindo-o se estiver fechado. */
function listaDoMulti(id: string): HTMLElement {
  const raiz = document.getElementById(id)!;
  const gatilho = raiz.querySelector('button')!;
  if (gatilho.getAttribute('aria-expanded') !== 'true') fireEvent.click(gatilho);
  return raiz.querySelector('ul[role="listbox"]') as HTMLElement;
}

/** Marca/desmarca a opção com aquele rótulo no MultiSelect real (o operador clicando, não a prop). */
function alternarNoMulti(id: string, label: string): void {
  const alvo = within(listaDoMulti(id)).getByText(label);
  fireEvent.click(alvo.closest('button')!);
}

function preencherTudo(): void {
  fireEvent.change(screen.getByTestId('tp-modality'), { target: { value: 'HYBRID' } });
  fireEvent.click(screen.getByTestId('icd-pick-a'));
  fireEvent.change(screen.getByTestId('tp-clinicalContext'), { target: { value: '  contexto clínico  ' } });
  fireEvent.change(screen.getByTestId('tp-generalObjective'), { target: { value: '  objetivo geral  ' } });
  alternarNoMulti('tp-specificObjectives', 'Objetivo 1');
  alternarNoMulti('tp-activities', 'Atividade 1');
  fireEvent.change(screen.getByTestId('tp-startDate'), { target: { value: '2026-09-01' } });
  fireEvent.change(screen.getByTestId('tp-endDate'), { target: { value: '2026-12-01' } });
}

beforeEach(() => {
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

    const select = screen.getByTestId('tp-service') as HTMLSelectElement;
    expect(select.value).toBe('svc-1');
    const opcoes = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(opcoes).toContain('Acompanhante Terapêutico · 20 h/sem');
    expect(opcoes).toContain('Cuidador'); // `weeklyHours: null` → sem o sufixo
    expect(screen.queryByTestId('tp-no-service')).not.toBeInTheDocument();
  });

  it('serviço INATIVO não entra na lista de escolha', () => {
    montar({ services: [servico(), servico({ id: 'svc-morto', active: false, serviceCode: 'CAREGIVER' })] });

    const select = screen.getByTestId('tp-service') as HTMLSelectElement;
    expect(Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'svc-1']);
  });

  it('🔴 sem NENHUM serviço ativo: aviso âmbar e "Salvar" travado (não há o que vincular)', () => {
    montar({ services: [servico({ active: false })] });

    expect(screen.getByTestId('tp-no-service')).toHaveTextContent(tf('noActiveService'));
    expect((screen.getByTestId('tp-service') as HTMLSelectElement).value).toBe('');
    expect(salvar().disabled).toBe(true);
  });

  it('trocar o serviço marca o formulário como sujo', () => {
    montar();

    fireEvent.change(screen.getByTestId('tp-service'), { target: { value: 'svc-2' } });

    expect((screen.getByTestId('tp-service') as HTMLSelectElement).value).toBe('svc-2');
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

  it('remover TODOS os chips trava o "Salvar" (CID é obrigatório)', () => {
    montar({ patientDiagnoses: [] });
    preencherTudo();
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
    ['objetivos específicos desmarcados', () => alternarNoMulti('tp-specificObjectives', 'Objetivo 1')],
    ['atividades desmarcadas', () => alternarNoMulti('tp-activities', 'Atividade 1')],
    ['data de início apagada', () => fireEvent.change(screen.getByTestId('tp-startDate'), { target: { value: '' } })],
    ['data de término apagada', () => fireEvent.change(screen.getByTestId('tp-endDate'), { target: { value: '' } })],
  ])('%s → continua travado', (_nome, quebrar) => {
    montar({ patientDiagnoses: [] });
    preencherTudo();
    expect(salvar().disabled).toBe(false);

    quebrar(); // desmarca/apaga o campo que preencherTudo tinha deixado válido

    expect(salvar().disabled).toBe(true);
  });

  it('🔴 término ANTES do início: mensagem de erro no campo e botão travado', () => {
    montar({ patientDiagnoses: [] });
    preencherTudo();

    fireEvent.change(screen.getByTestId('tp-endDate'), { target: { value: '2026-08-01' } });

    expect(screen.getByText(tf('endBeforeStart'))).toBeInTheDocument();
    expect(salvar().disabled).toBe(true);
  });

  it('término igual ao início é válido (a mensagem some)', () => {
    montar({ patientDiagnoses: [] });
    preencherTudo();

    fireEvent.change(screen.getByTestId('tp-endDate'), { target: { value: '2026-09-01' } });

    expect(screen.queryByText(tf('endBeforeStart'))).not.toBeInTheDocument();
    expect(salvar().disabled).toBe(false);
  });

  it('D301 — modalidade: obrigatória (sem ela "Salvar" trava), 3 opções traduzidas; versão antiga com `null` abre vazia e exige escolha', () => {
    montar({ patientDiagnoses: [] });
    preencherTudo();
    expect(salvar().disabled).toBe(false);
    fireEvent.change(screen.getByTestId('tp-modality'), { target: { value: '' } });
    expect(salvar().disabled).toBe(true);
    const opcoes = Array.from((screen.getByTestId('tp-modality') as HTMLSelectElement).options).map((o) => o.value).filter(Boolean);
    expect(opcoes).toEqual(['IN_PERSON', 'ONLINE', 'HYBRID']);
    expect(screen.getByText(ptBR.admin.patients.detail.therapeuticProjectCard.modalityOptions.ONLINE)).toBeInTheDocument();
    cleanup();
    montar({ from: { ...VERSAO, modality: null } });
    expect((screen.getByTestId('tp-modality') as HTMLSelectElement).value).toBe('');
    expect(salvar().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('tp-modality'), { target: { value: 'ONLINE' } });
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
  it('manda o corpo com os textos em `trim` e sem `major`/`minor` (a numeração é do servidor)', () => {
    montar({ patientDiagnoses: [] });
    preencherTudo();

    fireEvent.click(salvar());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      contractedServiceId: 'svc-1',
      modality: 'HYBRID',
      diagnoses: [{ uri: 'urn:icd:A', title: 'Diagnóstico A' }],
      clinicalContext: 'contexto clínico',
      generalObjective: 'objetivo geral',
      specificObjectiveIds: ['so1'],
      activityIds: ['ac1'],
      startDate: '2026-09-01',
      endDate: '2026-12-01',
      contactRefs: [],
      careTeamIds: [],
    });
    expect(Object.keys(onSubmit.mock.calls[0][0])).not.toContain('major');
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

  it('serviço travado cujo id não existe em `services` (removido/de outro paciente): cai no id cru, não quebra', () => {
    montar({ from: { ...VERSAO, contractedServiceId: 'svc-removido' } });

    expect(screen.getByTestId('tp-service-locked')).toHaveTextContent('svc-removido');
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

  it('marcar um responsável, um externo, um de cobertura e um da equipe monta `contactRefs`/`careTeamIds` no envio', () => {
    montar({ patientDiagnoses: [] });
    preencherTudo();

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

  it('"Editar" nasce com os `contactRefs`/`careTeamIds` da versão de origem, não em branco', () => {
    montar({
      from: { ...VERSAO, contactRefs: [{ kind: 'RESPONSIBLE', id: 'resp-1' }, { kind: 'COVERAGE', id: 'cov-1' }], careTeamIds: ['prof-1'] },
    });

    const respostas = within(listaDoMulti('tp-responsibles')).getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(respostas.map((o) => o.textContent)).toEqual(['Marta Gómez']);
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

// ── Filtro de segmento (US-17) — escondido com catálogo vazio ──────────────

describe('filtro de segmento (US-17, PR-7)', () => {
  it('catálogo `segments` vazio (default): o filtro não aparece', () => {
    montar();

    expect(screen.queryByTestId('tp-segment-filter')).not.toBeInTheDocument();
  });

  it('catálogo `segments` com itens: o filtro aparece e filtra as opções dos 2 multi-selects', () => {
    montar({
      patientDiagnoses: [],
      catalogs: {
        'specific-objectives': [
          { ...item('so1', 'Objetivo 1'), segmentId: 'seg-A' },
          { ...item('so2', 'Objetivo 2'), segmentId: 'seg-B' },
        ],
        activities: [item('ac1', 'Atividade 1')],
        segments: [item('seg-A', 'Segmento A'), item('seg-B', 'Segmento B')],
      },
    });

    expect(screen.getByTestId('tp-segment-filter')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('tp-segment-filter'), { target: { value: 'seg-A' } });

    const lista = listaDoMulti('tp-specificObjectives');
    expect(within(lista).getByText('Objetivo 1')).toBeInTheDocument();
    expect(within(lista).queryByText('Objetivo 2')).not.toBeInTheDocument();
  });

  it('item já escolhido continua na lista mesmo filtrado por outro segmento (mesma régua do `optionsOf`)', () => {
    montar({
      from: { ...VERSAO, specificObjectives: [{ id: 'so2', label: 'Objetivo 2', segmentId: 'seg-B' }] },
      fieldClass: FIELD_CLASS_SEM_MACRO,
      catalogs: {
        'specific-objectives': [{ ...item('so1', 'Objetivo 1'), segmentId: 'seg-A' }],
        activities: [item('ac1', 'Atividade 1')],
        segments: [item('seg-A', 'Segmento A'), item('seg-B', 'Segmento B')],
      },
    });

    fireEvent.change(screen.getByTestId('tp-segment-filter'), { target: { value: 'seg-A' } });

    expect(within(listaDoMulti('tp-specificObjectives')).getByText('Objetivo 2')).toBeInTheDocument();
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
