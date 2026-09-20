import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { Gated, ReadOnlyField, ActionButton, PanelErrorAlert, FeatureGate, FeatureRouteGate } from '..';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const pronto = (permissions: string[]) =>
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {} } as AuthzContract,
  });

// M1 (D268) — default `enforcement: 'on'`: estes casos exercitam a régua de
// MAPA do `FeatureGate`/`FeatureRouteGate`; o freio de rollout tem describe própria em `useFeature.test.tsx`.
const prontoFeatures = (
  countries: string[],
  features: AuthzContract['features'],
  enforcement: AuthzContract['enforcement'] = 'on',
) =>
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: [], countries, groups: [], features, enforcement } as AuthzContract,
  });

describe('Gated — as três posturas', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('hidden: NADA entra na árvore — nem wrapper', () => {
    pronto([]);
    const { container } = render(<Gated resource="x"><span>conteúdo</span></Gated>);
    expect(container).toBeEmptyDOMElement();
  });

  it('read: existe; e `atLeast="write"` continua ausente', () => {
    pronto(['x:read']);
    render(
      <>
        <Gated resource="x"><span>leitura</span></Gated>
        <Gated resource="x" atLeast="write"><span>escrita</span></Gated>
      </>,
    );
    expect(screen.getByText('leitura')).toBeInTheDocument();
    expect(screen.queryByText('escrita')).not.toBeInTheDocument();
  });

  it('write: os dois existem, e o render-prop recebe o nível', () => {
    pronto(['x:write']);
    render(<Gated resource="x">{({ level, canWrite }) => <span>{`${level}/${canWrite}`}</span>}</Gated>);
    expect(screen.getByText('write/true')).toBeInTheDocument();
  });

  it('🔴 contrato ausente: hidden, mesmo sem erro explícito', () => {
    const { container } = render(<Gated resource="x"><span>x</span></Gated>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ReadOnlyField', () => {
  it('editable=false: mostra TEXTO e não monta o input', () => {
    render(
      <ReadOnlyField id="nome" label="Nome" value="Grupo A" editable={false}>
        <input id="nome" defaultValue="Grupo A" />
      </ReadOnlyField>,
    );
    expect(screen.getByText('Grupo A')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('editable=false com valor vazio mostra "—", não um vazio silencioso', () => {
    render(<ReadOnlyField id="d" label="Descrição" value="" editable={false} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('editable=true: monta o input', () => {
    render(
      <ReadOnlyField id="nome" label="Nome" value="Grupo A" editable>
        <input id="nome" defaultValue="Grupo A" />
      </ReadOnlyField>,
    );
    expect(screen.getByRole('textbox')).toHaveValue('Grupo A');
  });
});

// D269 — `pronto` (sem `enforcement`) simula o freio de rollout DESLIGADO:
// `prontoOn` liga a régua explicitamente, que é onde o `ActionButton` gateia.
const prontoOn = (permissions: string[]) =>
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u',
      tenantId: 't',
      status: 'ACTIVE',
      permissions,
      countries: [],
      groups: [],
      features: {},
      enforcement: 'on',
    } as AuthzContract,
  });

describe('ActionButton — D269 (mode="hide" default — correção do Gabriel: "esconder, não desabilitar")', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('(a) enforcement=on, sem célula: o botão NÃO EXISTE no DOM (nem disabled, nem title)', () => {
    prontoOn(['x:read']);
    const onClick = vi.fn();
    render(<ActionButton resource="x" onClick={onClick}>Salvar</ActionButton>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('(b) enforcement=on, com a célula: existe, habilitado, e clica', () => {
    prontoOn(['x:write']);
    const onClick = vi.fn();
    render(<ActionButton resource="x" onClick={onClick}>Salvar</ActionButton>);
    const btn = screen.getByRole('button', { name: 'Salvar' });
    expect(btn).not.toBeDisabled();
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('(c) enforcement OFF (ou ausente) e sem célula: existe, habilitado — botão normal', () => {
    pronto(['x:read']); // enforcement ausente = 'off'
    const onClick = vi.fn();
    render(<ActionButton resource="x" onClick={onClick}>Salvar</ActionButton>);
    const btn = screen.getByRole('button', { name: 'Salvar' });
    expect(btn).not.toBeDisabled();
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('(d) mode="disable" explícito: sem célula, fica desabilitado — title, data-gate, onClick não dispara', () => {
    prontoOn(['x:read']);
    const onClick = vi.fn();
    render(<ActionButton resource="x" mode="disable" onClick={onClick}>Salvar</ActionButton>);
    const btn = screen.getByRole('button', { name: 'Salvar' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('title', 'access.actionDenied');
    expect(btn).toHaveAttribute('data-gate', 'denied');
    btn.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('(e) action="delete": gateia pela célula x:delete, não x:write', () => {
    prontoOn(['x:write']); // tem write, mas NÃO tem delete
    const semDelete = render(<ActionButton resource="x" action="delete">Excluir</ActionButton>);
    expect(screen.queryByRole('button', { name: 'Excluir' })).not.toBeInTheDocument();
    semDelete.unmount();

    prontoOn(['x:delete']);
    render(<ActionButton resource="x" action="delete">Excluir</ActionButton>);
    expect(screen.getByRole('button', { name: 'Excluir' })).toBeInTheDocument();
  });
});

describe('FeatureGate — fail-OPEN por mapa, fail-CLOSED por chave (B1/D268)', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('1. features ausentes/vazias (país único, mapa vazio) → renderiza + warn uma vez', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prontoFeatures(['AR'], {});
    render(<FeatureGate feature="screen:caso1"><span>conteúdo</span></FeatureGate>);
    expect(screen.getByText('conteúdo')).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing-map'));
    warn.mockRestore();
  });

  it('2. ator sem país único (0 países) → renderiza + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prontoFeatures([], { AR: { 'screen:caso2': { enabled: false, config: null } } });
    render(<FeatureGate feature="screen:caso2"><span>conteúdo</span></FeatureGate>);
    expect(screen.getByText('conteúdo')).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no-actor-country'));
    warn.mockRestore();
  });

  it('2b. ator com MAIS de um país (ambíguo) → também fail-open', () => {
    prontoFeatures(['AR', 'BR'], { AR: { 'screen:caso2b': { enabled: false, config: null } } });
    render(<FeatureGate feature="screen:caso2b"><span>conteúdo</span></FeatureGate>);
    expect(screen.getByText('conteúdo')).toBeInTheDocument();
  });

  it('3. mapa presente, chave enabled:false → SOME do DOM (fail-closed)', () => {
    prontoFeatures(['AR'], { AR: { 'screen:caso3': { enabled: false, config: null } } });
    const { container } = render(<FeatureGate feature="screen:caso3"><span>conteúdo</span></FeatureGate>);
    expect(screen.queryByText('conteúdo')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('4. chave ausente no mapa do país → renderiza + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prontoFeatures(['AR'], { AR: { 'screen:outra': { enabled: true, config: null } } });
    render(<FeatureGate feature="screen:caso4"><span>conteúdo</span></FeatureGate>);
    expect(screen.getByText('conteúdo')).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing-key'));
    warn.mockRestore();
  });

  it('5. mapa presente, chave enabled:true → renderiza, sem warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prontoFeatures(['AR'], { AR: { 'screen:caso5': { enabled: true, config: null } } });
    render(<FeatureGate feature="screen:caso5"><span>conteúdo</span></FeatureGate>);
    expect(screen.getByText('conteúdo')).toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('FeatureRouteGate — a versão de rota (redireciona ao índice quando desligada)', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('habilitada: renderiza os children normalmente', () => {
    prontoFeatures(['AR'], { AR: { 'screen:rota-on': { enabled: true, config: null } } });
    render(
      <MemoryRouter initialEntries={['/admin/x']}>
        <Routes>
          <Route path="/admin/x" element={<FeatureRouteGate feature="screen:rota-on"><span>pagina</span></FeatureRouteGate>} />
          <Route path="/admin" element={<span>indice</span>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('pagina')).toBeInTheDocument();
  });

  it('desligada: redireciona para /admin — a rota gated nunca aparece', () => {
    prontoFeatures(['AR'], { AR: { 'screen:rota-off': { enabled: false, config: null } } });
    render(
      <MemoryRouter initialEntries={['/admin/x']}>
        <Routes>
          <Route path="/admin/x" element={<FeatureRouteGate feature="screen:rota-off"><span>pagina</span></FeatureRouteGate>} />
          <Route path="/admin" element={<span>indice</span>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText('pagina')).not.toBeInTheDocument();
    expect(screen.getByText('indice')).toBeInTheDocument();
  });
});

describe('ReadOnlyField sem id / PanelErrorAlert', () => {
  it('sem `id` não gera data-testid, e ainda mostra o valor', () => {
    render(<ReadOnlyField label="L" value="V" editable={false} />);
    expect(screen.getByText('V')).toBeInTheDocument();
    expect(document.querySelector('[data-testid]')).toBeNull();
    const { container } = render(<PanelErrorAlert keyName={null} />);
    expect(container).toBeEmptyDOMElement();
    render(<PanelErrorAlert keyName="k" />);
    expect(screen.getByRole('alert')).toHaveTextContent('k');
  });
});
