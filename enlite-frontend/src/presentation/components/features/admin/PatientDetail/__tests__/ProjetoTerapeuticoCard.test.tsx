/**
 * ProjetoTerapeuticoCard — o card da ficha (spec 017 F4; Figma `6390:13229`). Deixou de ser
 * placeholder em 08/09/2026.
 *
 * O que estes testes seguram:
 *  · D286 — "Novo" e "Editar" são `ActionButton` sob `patient_therapeutic_project:write`: com o
 *    engine LIGADO e sem a célula, os botões SOMEM (D269: "desabilitar não, ESCONDER"). O card
 *    inteiro fica sob o container — quem monta o `ContainerGate` é a página.
 *  · A versão "em andamento" é a mais recente por data de criação, ANULADAS FORA (Gabriel, 08/09).
 *    Versão anulada continua na tabela (histórico) mas riscada, e não pode virar origem de "Editar".
 *  · A ordem da tabela é a RECEBIDA do servidor — o card não reordena.
 *  · Sem serviço contratado ativo não há o que vincular: "Novo" desabilitado com o motivo no `title`,
 *    e o vazio diz o motivo em vez do texto genérico.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientContractedServiceDetail, PatientDetail } from '@domain/entities/PatientDetail';
import type { TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
import type { AuthzContract } from '@domain/entities/Authz';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { patientDetailFixture } from './patientDetailFixture';

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

// ── Dublês ───────────────────────────────────────────────────────────────────

const mockUseTherapeuticProjects = vi.fn();
vi.mock('@hooks/admin/useTherapeuticProjects', () => ({
  useTherapeuticProjects: (...a: unknown[]) => mockUseTherapeuticProjects(...a),
}));

// Dublê do drawer: expõe o `target` que o CARD montou e os dois closures que ele passa.
vi.mock('../therapeuticProject/TherapeuticProjectDrawer', () => ({
  TherapeuticProjectDrawer: ({ target, onClose, onSaved }: { target: { mode: string; version?: { id: string } }; onClose: () => void; onSaved: () => void }) => (
    <div data-testid="tp-drawer" data-mode={target.mode} data-version={target.version?.id ?? ''}>
      <button type="button" data-testid="tp-drawer-close" onClick={onClose}>close</button>
      <button type="button" data-testid="tp-drawer-saved" onClick={onSaved}>saved</button>
    </div>
  ),
}));

import { ProjetoTerapeuticoCard } from '../ProjetoTerapeuticoCard';

// ── Insumos ──────────────────────────────────────────────────────────────────

const tc = (k: string) => (ptBR.admin.patients.detail.therapeuticProjectCard as Record<string, any>)[k] as string;

const SERVICO: PatientContractedServiceDetail = {
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
};

const COM_SERVICO: PatientDetail = { ...patientDetailFixture, contractedServices: [SERVICO] };
const SEM_SERVICO_ATIVO: PatientDetail = { ...patientDetailFixture, contractedServices: [{ ...SERVICO, active: false }] };

const versao = (over: Partial<TherapeuticProjectVersion> = {}): TherapeuticProjectVersion => ({
  id: 'v1',
  patientId: patientDetailFixture.id,
  major: 1,
  minor: 0,
  version: 'V.1.0',
  editedFromVersionId: null,
  contractedServiceId: 'svc-1',
  diagnoses: [],
  clinicalContext: 'contexto',
  generalObjective: 'objetivo',
  specificObjectives: [],
  activities: [],
  pathologyTypes: [],
  startDate: '2026-09-01',
  endDate: '2026-12-01',
  annulledAt: null,
  annulledByName: null,
  annulReason: null,
  createdByName: 'Ana Fixture',
  createdAt: '2026-09-01T10:00:00Z',
  country: 'AR',
  ...over,
});

const refetch = vi.fn();

function comHook(over: { versions?: TherapeuticProjectVersion[]; isLoading?: boolean; error?: string | null } = {}): void {
  mockUseTherapeuticProjects.mockReturnValue({
    versions: over.versions ?? [],
    isLoading: over.isLoading ?? false,
    error: over.error ?? null,
    refetch,
  });
}

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement'] = 'on'): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

const montar = (patient: PatientDetail = COM_SERVICO) => render(<ProjetoTerapeuticoCard patient={patient} />);

beforeEach(() => {
  vi.clearAllMocks();
  useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  comHook();
});

// ── Carregando · erro · vazio ────────────────────────────────────────────────

describe('estados de carga', () => {
  it('pergunta pelas versões DESTE paciente', () => {
    montar();

    expect(mockUseTherapeuticProjects).toHaveBeenCalledWith(patientDetailFixture.id);
  });

  it('carregando: esqueleto da tabela, sem tabela e sem vazio', () => {
    comHook({ isLoading: true });
    montar();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('tp-versions-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tp-empty')).not.toBeInTheDocument();
  });

  it('🔴 erro tem precedência sobre o carregando: a tela mostra a recusa, não o esqueleto', () => {
    comHook({ isLoading: true, error: 'Você não tem permissão para ver este dado' });
    montar();

    expect(screen.getByTestId('tp-load-error')).toHaveTextContent('Você não tem permissão para ver este dado');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('vazio COM serviço ativo: o texto genérico ("ainda não tem projeto")', () => {
    montar();

    expect(screen.getByTestId('tp-empty')).toHaveTextContent(tc('empty'));
  });

  it('🔴 vazio SEM serviço ativo: o texto diz o MOTIVO, não o genérico', () => {
    montar(SEM_SERVICO_ATIVO);

    expect(screen.getByTestId('tp-empty')).toHaveTextContent(tc('needsService'));
    expect(screen.getByTestId('tp-empty')).not.toHaveTextContent(tc('empty'));
  });
});

// ── "Novo" e "Editar" ────────────────────────────────────────────────────────

describe('"Novo" e "Editar"', () => {
  it('com serviço ativo, "Novo" está habilitado e sem `title` de motivo', () => {
    montar();

    const novo = screen.getByTestId('tp-new-btn') as HTMLButtonElement;
    expect(novo.disabled).toBe(false);
    expect(novo.getAttribute('title')).toBeNull();
  });

  it('🔴 sem serviço ativo, "Novo" fica desabilitado com o motivo no `title`', () => {
    montar(SEM_SERVICO_ATIVO);

    const novo = screen.getByTestId('tp-new-btn') as HTMLButtonElement;
    expect(novo.disabled).toBe(true);
    expect(novo.getAttribute('title')).toBe(tc('needsService'));
  });

  it('sem NENHUMA versão viva não há "Editar" (não existe o que editar)', () => {
    montar();

    expect(screen.queryByTestId('tp-edit-btn')).not.toBeInTheDocument();
  });

  it('🔒 com TODAS as versões anuladas também não há "Editar" (anulada não vira origem)', () => {
    comHook({ versions: [versao({ id: 'va', annulledAt: '2026-09-05' })] });
    montar();

    expect(screen.queryByTestId('tp-edit-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tp-current')).not.toBeInTheDocument();
    expect(screen.getByTestId('tp-versions-table')).toBeInTheDocument(); // o histórico continua
  });
});

// ── Tabela e resumo ──────────────────────────────────────────────────────────

describe('resumo da versão em andamento + tabela do histórico', () => {
  const VERSOES = [
    versao({ id: 'v3', version: 'V.2.0', createdAt: '2026-09-05T10:00:00Z', createdByName: 'Gabriel QA', startDate: '2026-10-01', endDate: '2026-12-31' }),
    versao({ id: 'v2', version: 'V.1.1', createdAt: '2026-09-03T10:00:00Z', annulledAt: '2026-09-04', createdByName: null }),
    versao({ id: 'v1', version: 'V.1.0', createdAt: '2026-09-01T10:00:00Z', startDate: '', endDate: '' }),
  ];

  it('mostra a versão em andamento (a mais recente VIVA) em modo compacto', () => {
    comHook({ versions: VERSOES });
    montar();

    expect(screen.getByTestId('tp-current')).toBeInTheDocument();
    expect(screen.getByTestId('therapeutic-project-version-view').getAttribute('data-version')).toBe('V.2.0');
  });

  it('a tabela segue a ORDEM RECEBIDA do servidor (o card não reordena)', () => {
    comHook({ versions: VERSOES });
    montar();

    const linhas = screen.getByTestId('tp-versions-table').querySelectorAll('tbody tr');
    expect(Array.from(linhas).map((l) => l.getAttribute('data-testid'))).toEqual(['tp-row-v3', 'tp-row-v2', 'tp-row-v1']);
  });

  it('🔒 a linha ANULADA vem riscada; autor ausente vira `—` e data vazia vira `—`', () => {
    comHook({ versions: VERSOES });
    montar();

    expect(screen.getByTestId('tp-row-v2').className).toContain('line-through');
    expect(screen.getByTestId('tp-row-v3').className).not.toContain('line-through');
    expect(screen.getByTestId('tp-row-v2')).toHaveTextContent('—');
    expect(screen.getByTestId('tp-row-v1')).toHaveTextContent('—');
    expect(screen.getByTestId('tp-row-v3')).toHaveTextContent('01/10/2026');
    expect(screen.getByTestId('tp-row-v3')).toHaveTextContent('Gabriel QA');
  });
});

// ── Abertura do drawer ───────────────────────────────────────────────────────

describe('abertura do drawer', () => {
  const VERSOES = [
    versao({ id: 'v2', version: 'V.2.0', createdAt: '2026-09-05T10:00:00Z' }),
    versao({ id: 'v1', version: 'V.1.0', createdAt: '2026-09-01T10:00:00Z' }),
  ];

  it('o drawer só existe depois de um clique', () => {
    comHook({ versions: VERSOES });
    montar();

    expect(screen.queryByTestId('tp-drawer')).not.toBeInTheDocument();
  });

  it('clique na LINHA abre a versão daquela linha em leitura', () => {
    comHook({ versions: VERSOES });
    montar();

    fireEvent.click(screen.getByTestId('tp-row-v1'));

    expect(screen.getByTestId('tp-drawer').getAttribute('data-mode')).toBe('view');
    expect(screen.getByTestId('tp-drawer').getAttribute('data-version')).toBe('v1');
  });

  it('clique no OLHO abre a mesma versão (e o `stopPropagation` não abre dois)', () => {
    comHook({ versions: VERSOES });
    montar();

    fireEvent.click(screen.getByTestId('tp-view-v1'));

    expect(screen.getAllByTestId('tp-drawer')).toHaveLength(1);
    expect(screen.getByTestId('tp-drawer').getAttribute('data-version')).toBe('v1');
  });

  it('"Novo" abre o drawer em `new`, sem versão de origem', () => {
    comHook({ versions: VERSOES });
    montar();

    fireEvent.click(screen.getByTestId('tp-new-btn'));

    expect(screen.getByTestId('tp-drawer').getAttribute('data-mode')).toBe('new');
    expect(screen.getByTestId('tp-drawer').getAttribute('data-version')).toBe('');
  });

  it('"Editar" abre em `edit` a versão EM ANDAMENTO (a mais recente viva), não a clicada', () => {
    comHook({ versions: VERSOES });
    montar();

    fireEvent.click(screen.getByTestId('tp-edit-btn'));

    expect(screen.getByTestId('tp-drawer').getAttribute('data-mode')).toBe('edit');
    expect(screen.getByTestId('tp-drawer').getAttribute('data-version')).toBe('v2');
  });

  it('fechar o drawer o tira da árvore; salvar recarrega a lista', () => {
    comHook({ versions: VERSOES });
    montar();
    fireEvent.click(screen.getByTestId('tp-new-btn'));

    fireEvent.click(screen.getByTestId('tp-drawer-saved'));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('tp-drawer')).toBeInTheDocument(); // salvar não fecha

    fireEvent.click(screen.getByTestId('tp-drawer-close'));
    expect(screen.queryByTestId('tp-drawer')).not.toBeInTheDocument();
  });
});

// ── Gate de escrita (D286/D269) ──────────────────────────────────────────────

describe('🔒 D286/D269 — as ações de escrita são células do CONTAINER', () => {
  const VERSOES = [versao({ id: 'v1' })];

  it('engine LIGADO e sem `patient_therapeutic_project:write` → "Novo" e "Editar" SOMEM', () => {
    comEnforcement([]);
    comHook({ versions: VERSOES });
    montar();

    expect(screen.queryByTestId('tp-new-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tp-edit-btn')).not.toBeInTheDocument();
    // a leitura continua: a tabela e o resumo são do container, não da escrita
    expect(screen.getByTestId('tp-versions-table')).toBeInTheDocument();
    expect(screen.getByTestId('tp-current')).toBeInTheDocument();
  });

  it('🔴 `patient:write` do pai NÃO libera o card (a permissão é do container)', () => {
    comEnforcement(['patient:read', 'patient:write']);
    comHook({ versions: VERSOES });
    montar();

    expect(screen.queryByTestId('tp-new-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tp-edit-btn')).not.toBeInTheDocument();
  });

  it('com a célula do container os dois botões existem', () => {
    comEnforcement(['patient_therapeutic_project:write']);
    comHook({ versions: VERSOES });
    montar();

    expect(screen.getByTestId('tp-new-btn')).toBeInTheDocument();
    expect(screen.getByTestId('tp-edit-btn')).toBeInTheDocument();
  });

  it('engine DESLIGADO: os botões aparecem mesmo sem célula (freio de rollout, D268)', () => {
    comEnforcement([], 'off');
    comHook({ versions: VERSOES });
    montar();

    expect(screen.getByTestId('tp-new-btn')).toBeInTheDocument();
    expect(screen.getByTestId('tp-edit-btn')).toBeInTheDocument();
  });
});
