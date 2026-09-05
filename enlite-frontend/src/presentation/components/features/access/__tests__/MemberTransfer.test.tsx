import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { MemberTransfer, type TransferPerson } from '..';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }),
}));

const RECURSO = 'permission_management';

const podeEscrever = (): void => {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE',
      permissions: [`${RECURSO}:read`, `${RECURSO}:write`],
      countries: [], groups: [], features: {}, enforcement: 'on',
    } as AuthzContract,
  });
};

const ANA: TransferPerson = { userId: 'u-ana', name: 'Ana Joulie', email: 'ana@enlite.health' };
const DIEGO: TransferPerson = { userId: 'u-diego', name: 'Diego Pérez', email: 'diego@enlite.health' };
const JAVIER: TransferPerson = { userId: 'u-javier', name: 'Javier Soto', email: 'javier@enlite.health' };
const SEM_NOME: TransferPerson = { userId: 'u-sn', name: null, email: 'sinnombre@enlite.health' };
const TODOS = [ANA, DIEGO, JAVIER, SEM_NOME];

const MIEMBROS = 'admin.access.group.membersTitle';
const RESTO = 'admin.access.group.transfer.rest';
const PARA_DENTRO = 'admin.access.group.transfer.toMembers';
const PARA_FORA = 'admin.access.group.transfer.toRest';
const GUARDAR = 'admin.access.group.save';

function montar(over: Partial<Parameters<typeof MemberTransfer>[0]> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <MemberTransfer
      resource={RECURSO}
      memberIds={['u-ana']}
      people={TODOS}
      editable
      onSave={onSave}
      {...over}
    />,
  );
  return { onSave, ...utils };
}

const coluna = (nome: string): HTMLElement => screen.getByRole('listbox', { name: nome });
const nomesEm = (nome: string): string[] =>
  within(coluna(nome)).queryAllByRole('option').map((o) => o.textContent ?? '');

describe('MemberTransfer — a fronteira do grupo', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    podeEscrever();
  });

  it('🔒 `Resto del equipo` fica à ESQUERDA e `Miembros` à DIREITA', () => {
    // pedido do Gabriel (05/09). Sem esta asserção a troca passa despercebida:
    // os testes de comportamento acham as colunas por nome, não por posição.
    montar();
    const listas = screen.getAllByRole('listbox').map((l) => l.getAttribute('aria-label'));
    expect(listas).toEqual([RESTO, MIEMBROS]);
  });

  it('🔒 a seta → leva para Miembros e a ← devolve ao resto — a direção segue o lado', () => {
    // com as colunas trocadas, uma seta apontando para o lado contrário do
    // movimento seria pior que antes
    montar();
    const grade = screen.getByTestId('member-transfer');
    const ordem = [...grade.querySelectorAll('[role="listbox"], button[aria-label^="admin.access.group.transfer.to"]')]
      .map((e) => e.getAttribute('aria-label'));
    expect(ordem).toEqual([RESTO, PARA_DENTRO, PARA_FORA, MIEMBROS]);
  });

  it('parte quem está dentro de quem está fora, ordenado por nome', () => {
    montar();
    expect(nomesEm(MIEMBROS).join(' ')).toContain('Ana Joulie');
    const fora = nomesEm(RESTO);
    expect(fora.join(' ')).toContain('Diego Pérez');
    expect(fora.join(' ')).toContain('Javier Soto');
    expect(fora.join(' ')).not.toContain('Ana Joulie');
    // quem não tem nome cai pelo e-mail, e a ordenação é por aí
    expect(fora.join(' ')).toContain('sinnombre@enlite.health');
    expect(fora.findIndex((n) => n.includes('Diego'))).toBeLessThan(fora.findIndex((n) => n.includes('Javier')));
  });

  it('as duas setas nascem mortas: sem seleção, nenhuma tem o que mover', () => {
    montar();
    expect(screen.getByRole('button', { name: PARA_DENTRO })).toBeDisabled();
    expect(screen.getByRole('button', { name: PARA_FORA })).toBeDisabled();
    expect(screen.queryByRole('button', { name: GUARDAR })).not.toBeInTheDocument();
  });

  it('a seleção é de UM lado só — marcar do outro lado limpa o primeiro', async () => {
    montar();
    await userEvent.click(within(coluna(RESTO)).getByRole('option', { name: /Javier/ }));
    expect(screen.getByRole('button', { name: PARA_DENTRO })).toBeEnabled();
    expect(screen.getByRole('button', { name: PARA_FORA })).toBeDisabled();

    await userEvent.click(within(coluna(MIEMBROS)).getByRole('option', { name: /Ana/ }));
    // agora só a de voltar acende, e o Javier ficou desmarcado
    expect(screen.getByRole('button', { name: PARA_FORA })).toBeEnabled();
    expect(screen.getByRole('button', { name: PARA_DENTRO })).toBeDisabled();
    expect(within(coluna(RESTO)).getByRole('option', { name: /Javier/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('clicar de novo desmarca, e sem ninguém marcado a seta morre', async () => {
    montar();
    const javier = within(coluna(RESTO)).getByRole('option', { name: /Javier/ });
    await userEvent.click(javier);
    expect(javier).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(javier);
    expect(javier).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('button', { name: PARA_DENTRO })).toBeDisabled();
  });

  it('move em LOTE e salva add e remove no mesmo Guardar', async () => {
    const { onSave } = montar();
    await userEvent.click(within(coluna(RESTO)).getByRole('option', { name: /Javier/ }));
    await userEvent.click(within(coluna(RESTO)).getByRole('option', { name: /Diego/ }));
    await userEvent.click(screen.getByRole('button', { name: PARA_DENTRO }));
    expect(nomesEm(MIEMBROS).join(' ')).toContain('Javier Soto');

    await userEvent.click(within(coluna(MIEMBROS)).getByRole('option', { name: /Ana/ }));
    await userEvent.click(screen.getByRole('button', { name: PARA_FORA }));

    await userEvent.click(screen.getByRole('button', { name: GUARDAR }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [add, remove] = onSave.mock.calls[0];
    expect([...add].sort()).toEqual(['u-diego', 'u-javier']);
    expect(remove).toEqual(['u-ana']);
  });

  it('sem mudança pendente não há rodapé; com mudança, Cancelar devolve ao estado salvo', async () => {
    montar();
    expect(screen.queryByText('admin.access.group.transfer.unsaved')).not.toBeInTheDocument();

    await userEvent.click(within(coluna(RESTO)).getByRole('option', { name: /Javier/ }));
    await userEvent.click(screen.getByRole('button', { name: PARA_DENTRO }));
    expect(screen.getByText('admin.access.group.transfer.unsaved')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'admin.access.groups.cancel' }));
    expect(nomesEm(MIEMBROS).join(' ')).not.toContain('Javier');
    expect(screen.queryByText('admin.access.group.transfer.unsaved')).not.toBeInTheDocument();
  });

  it('o filtro corta as duas colunas, por nome e por e-mail', async () => {
    montar();
    const filtro = screen.getByLabelText('admin.access.group.transfer.filter');
    await userEvent.type(filtro, 'javier');
    expect(nomesEm(RESTO).join(' ')).toContain('Javier');
    expect(nomesEm(RESTO).join(' ')).not.toContain('Diego');
    expect(nomesEm(MIEMBROS)).toHaveLength(0);

    await userEvent.clear(filtro);
    await userEvent.type(filtro, 'ana@enlite');
    expect(nomesEm(MIEMBROS).join(' ')).toContain('Ana');
  });

  it('coluna vazia diz o que significa estar vazia', () => {
    const semMembros = montar({ memberIds: [] });
    expect(within(coluna(MIEMBROS)).getByText('admin.access.group.noMembers')).toBeInTheDocument();
    semMembros.unmount();

    montar({ memberIds: TODOS.map((p) => p.userId) });
    expect(within(coluna(RESTO)).getByText('admin.access.group.transfer.allInside')).toBeInTheDocument();
  });

  it('🔒 quem está travado não é selecionável nem sai no lote', async () => {
    const { onSave } = montar({
      memberIds: ['u-ana', 'u-diego'],
      lockedIds: new Set(['u-diego']),
    });
    const diego = within(coluna(MIEMBROS)).getByRole('option', { name: /Diego/ });
    expect(diego).toBeDisabled();
    expect(diego).toHaveAttribute('title', 'admin.access.group.transfer.locked');

    // e mesmo que a seleção chegasse até ele, mover não o tira
    await userEvent.click(within(coluna(MIEMBROS)).getByRole('option', { name: /Ana/ }));
    await userEvent.click(screen.getByRole('button', { name: PARA_FORA }));
    await userEvent.click(screen.getByRole('button', { name: GUARDAR }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][1]).toEqual(['u-ana']);
  });

  it('read: só a lista de membros — sem colunas, sem setas, sem filtro', () => {
    montar({ editable: false });
    expect(screen.getByTestId('members-readonly')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PARA_DENTRO })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('admin.access.group.transfer.filter')).not.toBeInTheDocument();
    expect(screen.getByText('Ana Joulie')).toBeInTheDocument();
    // e ninguém de fora vaza para a vista de leitura
    expect(screen.queryByText('Javier Soto')).not.toBeInTheDocument();
  });

  it('read sem ninguém dentro: diz que não há membros', () => {
    montar({ editable: false, memberIds: [] });
    expect(screen.getByText('admin.access.group.noMembers')).toBeInTheDocument();
  });

  it('enquanto salva, Cancelar trava — e destrava quando a promessa volta', async () => {
    let liberar: () => void = () => undefined;
    const onSave = vi.fn().mockImplementation(() => new Promise<void>((r) => { liberar = r; }));
    render(
      <MemberTransfer resource={RECURSO} memberIds={['u-ana']} people={TODOS} editable onSave={onSave} />,
    );
    await userEvent.click(within(coluna(RESTO)).getByRole('option', { name: /Javier/ }));
    await userEvent.click(screen.getByRole('button', { name: 'admin.access.group.transfer.toMembers' }));
    await userEvent.click(screen.getByRole('button', { name: GUARDAR }));

    expect(screen.getByRole('button', { name: 'admin.access.groups.cancel' })).toBeDisabled();
    liberar();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'admin.access.groups.cancel' })).toBeEnabled(),
    );
  });

  it('sem a célula de escrita as setas e o Guardar SOMEM — a lista continua legível', async () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: {
        uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: [`${RECURSO}:read`],
        countries: [], groups: [], features: {}, enforcement: 'on',
      } as AuthzContract,
    });
    montar();
    expect(screen.queryByRole('button', { name: PARA_DENTRO })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PARA_FORA })).not.toBeInTheDocument();
    expect(nomesEm(MIEMBROS).join(' ')).toContain('Ana Joulie');
  });
});
