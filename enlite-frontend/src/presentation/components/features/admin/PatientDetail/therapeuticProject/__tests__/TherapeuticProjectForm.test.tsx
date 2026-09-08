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
import type { PatientContractedServiceDetail, PatientDiagnosisDetail } from '@domain/entities/PatientDetail';
import type { TherapeuticCatalogItem, TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
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
  'pathology-types': [item('pt1', 'Neurológica')],
};

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
  alternarNoMulti('tp-pathologyTypes', 'Neurológica');
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
    ['tipos de patologia desmarcados', () => alternarNoMulti('tp-pathologyTypes', 'Neurológica')],
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
      pathologyTypeIds: ['pt1'],
      startDate: '2026-09-01',
      endDate: '2026-12-01',
    });
    expect(Object.keys(onSubmit.mock.calls[0][0])).not.toContain('major');
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
  it('serviço, CID, textos, catálogos e prazos vêm da versão (não do cadastro)', () => {
    montar({ from: VERSAO });

    expect((screen.getByTestId('tp-service') as HTMLSelectElement).value).toBe('svc-2');
    expect(screen.getAllByTestId('tp-diagnosis-chip').map((c) => c.textContent)).toEqual(['Diagnóstico B']);
    expect((screen.getByTestId('tp-clinicalContext') as HTMLTextAreaElement).value).toBe('contexto de origem');
    expect((screen.getByTestId('tp-generalObjective') as HTMLTextAreaElement).value).toBe('objetivo de origem');
    expect((screen.getByTestId('tp-startDate') as HTMLInputElement).value).toBe('2026-01-10');
    expect((screen.getByTestId('tp-endDate') as HTMLInputElement).value).toBe('2026-06-10');
    expect(salvar().disabled).toBe(false);
  });

  it('🔒 `optionsOf`: item do snapshot que já NÃO está ativo no catálogo continua como opção', () => {
    montar({ from: VERSAO });

    const lista = listaDoMulti('tp-specificObjectives');

    // o catálogo vivo tem Objetivo 1 e 2; o snapshot tem `so-morto`, que precisa aparecer também
    expect(within(lista).getByText('Objetivo DESATIVADO no catálogo')).toBeInTheDocument();
    expect(within(lista).getByText('Objetivo 1')).toBeInTheDocument();
    expect(lista.querySelectorAll('li[role="option"]')).toHaveLength(3);
  });

  it('item do snapshot que AINDA está no catálogo não é duplicado', () => {
    montar({ from: VERSAO });

    expect(listaDoMulti('tp-activities').querySelectorAll('li[role="option"]')).toHaveLength(1);
  });

  it('versão de origem sem CID (`diagnoses: null`) cai no CID ativo do cadastro', () => {
    montar({ from: { ...VERSAO, diagnoses: null } });

    expect(screen.getAllByTestId('tp-diagnosis-chip').map((c) => c.textContent)).toEqual(['Diagnóstico A', 'Diagnóstico C']);
  });

  it('salvar a partir da origem manda o corpo da versão de origem (com o item desativado dentro)', () => {
    montar({ from: VERSAO });

    fireEvent.click(salvar());

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      contractedServiceId: 'svc-2',
      modality: 'IN_PERSON',
      specificObjectiveIds: ['so-morto'],
      startDate: '2026-01-10',
      endDate: '2026-06-10',
    }));
  });
});

// ── lex C7: versão redigida ──────────────────────────────────────────────────

describe('🔒 lex C7 — versão redigida não vira versão nova', () => {
  it('mostra o aviso e trava "Salvar" mesmo com o resto preenchido; os textos nascem vazios', () => {
    montar({ from: { ...VERSAO, redacted: { clinical: true }, clinicalContext: null, generalObjective: null } });

    expect(screen.getByTestId('tp-form-redacted')).toHaveTextContent(tf('redactedCannotEdit'));
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
