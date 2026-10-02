/**
 * DeletePatientDocumentConfirm — spec 031, FR-014: texto es-AR exato, foco inicial em "Cancelar",
 * Esc/fundo/X fecham, "Eliminar" confirma, nada fecha durante a exclusão, nome mascarado.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { i18nMock } from './documentsTestKit';

vi.mock('react-i18next', () => i18nMock);

import { DeletePatientDocumentConfirm } from '../DeletePatientDocumentConfirm';

function setup(props: Partial<React.ComponentProps<typeof DeletePatientDocumentConfirm>> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(<DeletePatientDocumentConfirm name="DNI frente" busy={false} onConfirm={onConfirm} onClose={onClose} {...props} />);
  return { onConfirm, onClose };
}

describe('DeletePatientDocumentConfirm', () => {
  it('mostra "¿Eliminar «nombre»?" e "no se puede deshacer", com o nome mascarado no Clarity', () => {
    setup();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName(/^¿Eliminar «\s*DNI frente\s*»\?$/);
    expect(document.getElementById('patient-document-delete-title')?.textContent).toBe('¿Eliminar «DNI frente»?');
    expect(screen.getByText('Esta acción no se puede deshacer.')).toBeInTheDocument();
    expect(screen.getByTestId('patient-document-delete-name')).toHaveAttribute('data-clarity-mask', 'True');
    expect(screen.getByTestId('patient-document-delete-name')).toHaveTextContent('DNI frente');
  });

  it('o foco inicial está em Cancelar — Enter logo ao abrir não exclui', async () => {
    const { onConfirm, onClose } = setup();
    expect(screen.getByTestId('patient-document-delete-cancel')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Eliminar confirma, sem fechar', async () => {
    const { onConfirm, onClose } = setup();
    await userEvent.click(screen.getByTestId('patient-document-delete-yes'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('patient-document-delete-yes')).toHaveTextContent('Eliminar');
  });

  it('Cancelar, o X e Esc fecham; outra tecla não; nenhum deles confirma', async () => {
    const { onConfirm, onClose } = setup();
    await userEvent.click(screen.getByTestId('patient-document-delete-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(3);
    await userEvent.keyboard('a');
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('clique no fundo fecha; clique dentro da caixa não', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('patient-document-delete-confirm'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('durante a exclusão: botões travados, texto "Eliminando…", Esc e fundo NÃO fecham', async () => {
    const { onClose } = setup({ busy: true });
    expect(screen.getByTestId('patient-document-delete-yes')).toBeDisabled();
    expect(screen.getByTestId('patient-document-delete-yes')).toHaveTextContent('Eliminando…');
    expect(screen.getByTestId('patient-document-delete-cancel')).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    fireEvent.click(screen.getByTestId('patient-document-delete-confirm'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('mostra a mensagem de erro da exclusão como alerta; sem erro, nenhum alerta', () => {
    const { onClose } = setup({ error: 'No pudimos eliminar el documento. Probá de nuevo.' });
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos eliminar el documento');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sem erro, não há alerta', () => {
    setup();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
