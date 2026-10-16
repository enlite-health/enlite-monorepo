/**
 * TherapeuticProjectContactField — "Todavía no hay registro" / "No necesita" num campo de contato (spec 048).
 * `MultiSelect`/`Checkbox` são os REAIS; o gate de célula é o store ABAC real (`useHasCell`), não um mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { useState } from 'react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { ContactStatusValue } from '@domain/entities/TherapeuticProject';
import type { AuthzContract } from '@domain/entities/Authz';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur !== 'string') return typeof opts === 'string' ? opts : key;
  return typeof opts === 'object' && opts ? cur.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => opts[k] ?? _) : cur;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

import { TherapeuticProjectContactField } from '../TherapeuticProjectContactField';

const tf = ptBR.admin.patients.detail.therapeuticProjectForm as Record<string, any>;
const OPCOES = [{ value: 'r1', label: 'Marta Gómez' }, { value: 'r2', label: 'Luis Gómez' }];

function comCelulas(permissions: string[]): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
  });
}

/** Estado vivo (o operador clicando, não a prop): o campo é controlado pelo pai. */
function Harness({ inicial = null, deadline = null, ids = [] }: { inicial?: ContactStatusValue | null; deadline?: string | null; ids?: string[] }): JSX.Element {
  const [status, setStatus] = useState<ContactStatusValue | null>(inicial);
  const [value, setValue] = useState<string[]>(ids);
  return (
    <TherapeuticProjectContactField
      fieldKey="responsibles" label="Responsáveis" options={OPCOES} value={value} onChange={setValue}
      status={status} onStatusChange={setStatus} inheritedDeadline={deadline} placeholder="Escolha"
    />
  );
}

const campo = () => screen.getByTestId('tp-field-responsibles');
const pendente = () => screen.getByTestId('tp-responsibles-pending') as HTMLInputElement;
const gatilho = () => document.getElementById('tp-responsibles')!.querySelector('button')!;

beforeEach(() => {
  cleanup();
  useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
});

describe('"Todavía no hay registro"', () => {
  it('marcar LIMPA a seleção e DESABILITA o select; mostra o aviso de 15 dias sob o campo', () => {
    comCelulas([]);
    render(<Harness ids={['r1']} />);
    expect(within(campo()).queryByTestId('tp-responsibles-deadline')).toBeNull();

    fireEvent.click(pendente());

    expect(pendente().checked).toBe(true);
    expect(gatilho()).toBeDisabled();
    expect(screen.getByTestId('tp-responsibles-deadline')).toHaveTextContent(tf.contactPendingDeadline);

    // a seleção anterior foi LIMPA de verdade (não só escondida): ao desmarcar, o select volta vazio
    fireEvent.click(pendente());
    expect(gatilho()).toHaveTextContent('Escolha');
    expect(gatilho()).not.toHaveTextContent('Marta');
  });

  it('travado, o select mostra o estado (não o "Escolha") e tem cara de desativado (borda tracejada)', () => {
    comCelulas(['patient_therapeutic_project:waive_contact']);
    render(<Harness />);
    fireEvent.click(pendente());
    expect(gatilho()).toHaveTextContent(tf.contactPending);
    expect(gatilho()).not.toHaveTextContent('Escolha');
    expect(gatilho().className).toContain('border-dashed');

    fireEvent.click(screen.getByTestId('tp-responsibles-waived'));
    expect(gatilho()).toHaveTextContent(tf.contactNotNeeded);

    fireEvent.click(screen.getByTestId('tp-responsibles-waived'));
    expect(gatilho()).toHaveTextContent('Escolha');
    expect(gatilho().className).not.toContain('border-dashed');
  });

  it('desmarcar reabilita o select e some o aviso', () => {
    comCelulas([]);
    render(<Harness inicial="PENDING" />);
    expect(gatilho()).toBeDisabled();
    fireEvent.click(pendente());
    expect(gatilho()).not.toBeDisabled();
    expect(screen.queryByTestId('tp-responsibles-deadline')).toBeNull();
  });

  it('campo que JÁ estava pendente mostra o prazo próprio ("até DD/MM"), não os 15 dias', () => {
    comCelulas([]);
    render(<Harness inicial="PENDING" deadline="2026-10-23" />);
    expect(screen.getByTestId('tp-responsibles-deadline')).toHaveTextContent('23/10');
    expect(screen.getByTestId('tp-responsibles-deadline')).not.toHaveTextContent(tf.contactPendingDeadline);
  });
});

describe('"No necesita" — só com a célula `waive_contact`', () => {
  it('SEM a célula a opção não existe na tela', () => {
    comCelulas(['patient_therapeutic_project:create']);
    render(<Harness />);
    expect(screen.queryByTestId('tp-responsibles-waived')).toBeNull();
    expect(screen.queryByLabelText(tf.contactNotNeeded, { exact: true })).toBeNull();
  });

  it('COM a célula: marcar limpa e desabilita; é exclusiva com "Todavía no hay registro"', () => {
    comCelulas(['patient_therapeutic_project:waive_contact']);
    render(<Harness ids={['r2']} />);
    const waived = screen.getByTestId('tp-responsibles-waived') as HTMLInputElement;

    fireEvent.click(waived);
    expect(waived.checked).toBe(true);
    expect(gatilho()).toBeDisabled();
    expect(pendente().checked).toBe(false);

    fireEvent.click(pendente());
    expect(pendente().checked).toBe(true);
    expect(waived.checked).toBe(false);
  });

  it('SEM a célula e NOT_NEEDED herdado: vê o texto "Não precisa" e escolher contatos o troca (P4)', () => {
    comCelulas([]);
    render(<Harness inicial="NOT_NEEDED" />);
    expect(screen.getByTestId('tp-responsibles-waived-text')).toHaveTextContent(tf.contactNotNeeded);
    expect(screen.queryByTestId('tp-responsibles-waived')).toBeNull();
    expect(gatilho()).not.toBeDisabled();

    fireEvent.click(gatilho());
    const lista = document.getElementById('tp-responsibles')!.querySelector('ul[role="listbox"]') as HTMLElement;
    fireEvent.click(within(lista).getByText('Marta Gómez').closest('button')!);

    expect(screen.queryByTestId('tp-responsibles-waived-text')).toBeNull();
  });
});

describe('escolher um contato desmarca o estado', () => {
  it('com o select habilitado (NOT_NEEDED herdado sem célula) — o estado some ao escolher; ids e estado nunca coexistem', () => {
    comCelulas([]);
    render(<Harness inicial="NOT_NEEDED" />);
    fireEvent.click(gatilho());
    const lista = document.getElementById('tp-responsibles')!.querySelector('ul[role="listbox"]') as HTMLElement;
    fireEvent.click(within(lista).getByText('Luis Gómez').closest('button')!);
    expect(pendente().checked).toBe(false);
    expect(screen.queryByTestId('tp-responsibles-waived-text')).toBeNull();
  });
});
