import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { Gated, ReadOnlyField, ActionButton } from '..';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const pronto = (permissions: string[]) =>
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {} } as AuthzContract,
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

describe('ActionButton', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('sem write: o botão NÃO existe (não é disabled)', () => {
    pronto(['x:read']);
    render(<ActionButton resource="x">Salvar</ActionButton>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('com write: existe e clica', () => {
    pronto(['x:write']);
    const onClick = vi.fn();
    render(<ActionButton resource="x" onClick={onClick}>Salvar</ActionButton>);
    screen.getByRole('button', { name: 'Salvar' }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
