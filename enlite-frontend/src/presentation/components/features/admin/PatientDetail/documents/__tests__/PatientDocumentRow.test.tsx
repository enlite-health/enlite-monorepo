/**
 * PatientDocumentRow — spec 031 (FR-004, FR-009, FR-013): metadados, gates por célula, "Ver",
 * excluir e renomear em linha (Enter salva, Esc cancela, vazio recusado e o nome antigo fica).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@infrastructure/http/ApiError';
import { i18nMock, syntheticDoc } from './documentsTestKit';

vi.mock('react-i18next', () => i18nMock);

import { PatientDocumentRow } from '../PatientDocumentRow';

function setup(
  doc = syntheticDoc(),
  props: Partial<React.ComponentProps<typeof PatientDocumentRow>> = {},
) {
  const onView = vi.fn();
  const onRename = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn();
  render(
    <PatientDocumentRow doc={doc} canUpdate canDelete onView={onView} onRename={onRename} onDelete={onDelete} {...props} />,
  );
  return { onView, onRename, onDelete };
}

const name = () => screen.getByTestId('patient-document-name-doc-1');

describe('PatientDocumentRow — leitura', () => {
  it('mostra nome (mascarado), origem "Subido en la ficha", autor, data e tamanho', () => {
    setup();
    expect(name()).toHaveTextContent('Documento de prueba');
    expect(name()).toHaveAttribute('data-clarity-mask', 'True');
    const meta = screen.getByTestId('patient-document-meta-doc-1').textContent ?? '';
    expect(meta).toContain('Subido en la ficha');
    expect(meta).toContain('Por Operadora Prueba');
    expect(meta).toMatch(/\d+ de oct\. a las /);
    expect(meta).toContain('2 KB');
  });

  it('documento vindo do chat → "Enviado por el chat"', () => {
    setup(syntheticDoc({ origin: 'chat' }));
    expect(screen.getByTestId('patient-document-meta-doc-1')).toHaveTextContent('Enviado por el chat');
  });

  it('sem nome decifrado e sem autor → rótulos genéricos, nunca vazio nem "null"', () => {
    setup(syntheticDoc({ label: null, createdByDisplayName: null }));
    expect(name()).toHaveTextContent('Documento sin nombre');
    expect(screen.getByTestId('patient-document-meta-doc-1')).toHaveTextContent('Autor desconocido');
    expect(document.body.textContent).not.toContain('null');
  });

  it('"Ver" chama onView com o id do documento', async () => {
    const { onView } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Ver' }));
    expect(onView).toHaveBeenCalledWith('doc-1');
  });

  it('excluir chama onDelete com o documento (a confirmação é de quem recebe)', async () => {
    const doc = syntheticDoc();
    const { onDelete } = setup(doc);
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    expect(onDelete).toHaveBeenCalledWith(doc);
  });
});

describe('PatientDocumentRow — gates por célula', () => {
  it('sem update o lápis some; sem delete o ícone de excluir some; "Ver" fica', () => {
    setup(syntheticDoc(), { canUpdate: false, canDelete: false });
    expect(screen.queryByRole('button', { name: 'Renombrar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ver' })).toBeInTheDocument();
  });

  it('com update e delete os dois aparecem', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Renombrar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Eliminar' })).toBeInTheDocument();
  });
});

describe('PatientDocumentRow — renomear em linha', () => {
  const edit = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Renombrar' }));
    return screen.getByTestId('patient-document-rename-input-doc-1') as HTMLInputElement;
  };

  it('lápis abre o campo com o nome atual, focado e mascarado; o lápis some enquanto edita', async () => {
    setup();
    const input = await edit();
    expect(input).toHaveValue('Documento de prueba');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('data-clarity-mask', 'True');
    expect(screen.queryByRole('button', { name: 'Renombrar' })).not.toBeInTheDocument();
  });

  it('digitar o nome novo e Enter salva o nome aparado e volta ao modo leitura', async () => {
    const { onRename } = setup();
    const input = await edit();
    await userEvent.clear(input);
    await userEvent.type(input, '  DNI dorso  {Enter}');
    expect(onRename).toHaveBeenCalledWith('doc-1', 'DNI dorso');
    expect(screen.queryByTestId('patient-document-rename-input-doc-1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Renombrar' })).toBeInTheDocument();
  });

  it('Esc cancela: nada é enviado e o nome antigo continua', async () => {
    const { onRename } = setup();
    const input = await edit();
    await userEvent.clear(input);
    await userEvent.type(input, 'outro nome{Escape}');
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('patient-document-rename-input-doc-1')).not.toBeInTheDocument();
    expect(name()).toHaveTextContent('Documento de prueba');
  });

  it('nome vazio ou só espaços é RECUSADO: mensagem, campo aberto, nada enviado; digitar limpa a mensagem', async () => {
    const { onRename } = setup();
    const input = await edit();
    await userEvent.clear(input);
    await userEvent.type(input, '   {Enter}');
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId('patient-document-rename-error-doc-1')).toHaveTextContent('El nombre no puede estar vacío');
    expect(screen.getByTestId('patient-document-rename-input-doc-1')).toBeInTheDocument();
    await userEvent.type(input, 'a');
    expect(screen.queryByTestId('patient-document-rename-error-doc-1')).not.toBeInTheDocument();
    // depois de recusado, Esc ainda devolve o nome antigo
    await userEvent.keyboard('{Escape}');
    expect(name()).toHaveTextContent('Documento de prueba');
  });

  it('nome igual ao atual só fecha o campo, sem chamar o servidor', async () => {
    const { onRename } = setup();
    await edit();
    await userEvent.keyboard('{Enter}');
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('patient-document-rename-input-doc-1')).not.toBeInTheDocument();
  });

  it('outras teclas não salvam nem cancelam', async () => {
    const { onRename } = setup();
    const input = await edit();
    await userEvent.type(input, 'x');
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId('patient-document-rename-input-doc-1')).toHaveValue('Documento de pruebax');
  });

  it('documento sem nome decifrado abre o campo vazio', async () => {
    setup(syntheticDoc({ label: null }));
    const input = await edit();
    expect(input).toHaveValue('');
  });

  it('falha de nome inválido do servidor → mensagem do nome, campo aberto', async () => {
    const { onRename } = setup();
    onRename.mockRejectedValueOnce(new ApiError({ success: false, error: 'x', code: 'INVALID_DOCUMENT_LABEL' }, 400));
    const input = await edit();
    await userEvent.type(input, 'z{Enter}');
    expect(await screen.findByTestId('patient-document-rename-error-doc-1')).toHaveTextContent('entre 1 y 255');
    expect(screen.getByTestId('patient-document-rename-input-doc-1')).not.toBeDisabled();
  });

  it('falha genérica → "No pudimos renombrar…", campo aberto para tentar de novo', async () => {
    const { onRename } = setup();
    onRename.mockRejectedValueOnce(new Error('rede'));
    const input = await edit();
    await userEvent.type(input, 'z{Enter}');
    expect(await screen.findByTestId('patient-document-rename-error-doc-1')).toHaveTextContent('No pudimos renombrar el documento');
  });

  it('Enter repetido durante o salvamento envia UMA vez só e o campo fica travado', async () => {
    const { onRename } = setup();
    let resolve!: () => void;
    onRename.mockReturnValueOnce(new Promise<void>((r) => { resolve = r; }));
    const input = await edit();
    await userEvent.type(input, 'z{Enter}');
    expect(input).toBeDisabled();
    // Enter no campo travado (disparo direto, userEvent ignora disabled)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    resolve();
    await screen.findByRole('button', { name: 'Renombrar' });
    expect(onRename).toHaveBeenCalledTimes(1);
  });
});
