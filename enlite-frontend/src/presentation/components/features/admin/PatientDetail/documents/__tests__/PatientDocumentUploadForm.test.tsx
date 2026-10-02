/**
 * PatientDocumentUploadForm — spec 031 (FR-002, FR-003): nome obrigatório (Subir desabilitado com
 * nome vazio/espaços ou sem arquivo), `accept`, envio aparado, limpeza após sucesso, 413/415 em es-AR.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@infrastructure/http/ApiError';
import { i18nMock } from './documentsTestKit';

vi.mock('react-i18next', () => i18nMock);

import { PatientDocumentUploadForm } from '../PatientDocumentUploadForm';

const pdf = () => new File(['%PDF-sintetico'], 'sintetico.pdf', { type: 'application/pdf' });
const labelInput = () => screen.getByTestId('patient-document-label-input') as HTMLInputElement;
const fileInput = () => screen.getByTestId('patient-document-file-input') as HTMLInputElement;
const uploadBtn = () => screen.getByTestId('patient-document-upload');

function setup(onUpload = vi.fn().mockResolvedValue(undefined)) {
  render(<PatientDocumentUploadForm onUpload={onUpload} />);
  return onUpload;
}

describe('PatientDocumentUploadForm', () => {
  it('estado inicial: campo com placeholder, seletor aceita só os 5 formatos, Subir desabilitado', () => {
    setup();
    expect(labelInput()).toHaveAttribute('placeholder', 'Nombre del documento (ej: DNI frente)');
    expect(labelInput()).toHaveAttribute('data-clarity-mask', 'True');
    expect(fileInput()).toHaveAttribute('accept', '.pdf,.png,.jpg,.jpeg,.docx');
    expect(screen.getByTestId('patient-document-file-name')).toHaveTextContent('Seleccionar archivo (PDF, JPG, PNG, DOCX)');
    expect(uploadBtn()).toBeDisabled();
  });

  it('nome vazio ou só espaços mantém Subir desabilitado mesmo com arquivo escolhido', async () => {
    setup();
    await userEvent.upload(fileInput(), pdf());
    expect(uploadBtn()).toBeDisabled();
    await userEvent.type(labelInput(), '    ');
    expect(uploadBtn()).toBeDisabled();
  });

  it('nome sem arquivo também mantém Subir desabilitado', async () => {
    setup();
    await userEvent.type(labelInput(), 'DNI frente');
    expect(uploadBtn()).toBeDisabled();
  });

  it('nome + arquivo habilita; o arquivo escolhido aparece (mascarado); envia o nome APARADO e limpa o formulário', async () => {
    const onUpload = setup();
    await userEvent.type(labelInput(), '  DNI frente  ');
    const file = pdf();
    await userEvent.upload(fileInput(), file);
    expect(screen.getByTestId('patient-document-file-name')).toHaveTextContent('sintetico.pdf');
    expect(screen.getByTestId('patient-document-file-name')).toHaveAttribute('data-clarity-mask', 'True');
    expect(uploadBtn()).toBeEnabled();
    await userEvent.click(uploadBtn());
    expect(onUpload).toHaveBeenCalledWith('DNI frente', file);
    expect(labelInput()).toHaveValue('');
    expect(screen.getByTestId('patient-document-file-name')).toHaveTextContent('Seleccionar archivo');
    expect(fileInput().value).toBe('');
    expect(uploadBtn()).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Enter no campo de nome envia (formulário de verdade)', async () => {
    const onUpload = setup();
    await userEvent.upload(fileInput(), pdf());
    await userEvent.type(labelInput(), 'Resumen{Enter}');
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it('Enter com o formulário incompleto não envia nada (nem por submit forçado)', async () => {
    const onUpload = setup();
    await userEvent.type(labelInput(), 'Resumen{Enter}');
    fireEvent.submit(screen.getByTestId('patient-document-upload-form'));
    expect(onUpload).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('o campo não passa de 255 caracteres', async () => {
    setup();
    await userEvent.click(labelInput());
    await userEvent.paste('a'.repeat(300));
    expect(labelInput().value).toHaveLength(255);
  });

  it('cancelar a escolha do arquivo (nenhum arquivo) volta a desabilitar', async () => {
    setup();
    await userEvent.type(labelInput(), 'X');
    await userEvent.upload(fileInput(), pdf());
    expect(uploadBtn()).toBeEnabled();
    await userEvent.upload(fileInput(), []);
    expect(uploadBtn()).toBeDisabled();
  });

  it('durante o envio: botão "Subiendo…" travado, sem segundo envio', async () => {
    let resolve!: () => void;
    const onUpload = vi.fn().mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    setup(onUpload);
    await userEvent.type(labelInput(), 'X');
    await userEvent.upload(fileInput(), pdf());
    await userEvent.click(uploadBtn());
    expect(uploadBtn()).toHaveTextContent('Subiendo…');
    expect(uploadBtn()).toBeDisabled();
    expect(onUpload).toHaveBeenCalledTimes(1);
    resolve();
    await screen.findByText('Subir');
  });

  it.each([
    [413, 'FILE_TOO_LARGE', 'El archivo supera los 10 MB'],
    [415, 'UNSUPPORTED_MEDIA_TYPE', 'Tipo de archivo no aceptado'],
  ])('erro %i do servidor vira mensagem es-AR, e nome e arquivo ficam para tentar de novo', async (status, code, text) => {
    const onUpload = vi.fn().mockRejectedValue(new ApiError({ success: false, error: 'interno.pdf', code }, status));
    setup(onUpload);
    await userEvent.type(labelInput(), 'DNI frente');
    await userEvent.upload(fileInput(), pdf());
    await userEvent.click(uploadBtn());
    expect(await screen.findByTestId('patient-document-upload-error')).toHaveTextContent(text);
    expect(screen.getByRole('alert')).not.toHaveTextContent('interno.pdf');
    expect(labelInput()).toHaveValue('DNI frente');
    expect(uploadBtn()).toBeEnabled();
  });

  it('falha de rede → mensagem genérica; um novo envio limpa o erro anterior', async () => {
    const onUpload = vi.fn().mockRejectedValueOnce(new Error('rede')).mockResolvedValueOnce(undefined);
    setup(onUpload);
    await userEvent.type(labelInput(), 'DNI frente');
    await userEvent.upload(fileInput(), pdf());
    await userEvent.click(uploadBtn());
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos subir el archivo');
    await userEvent.click(uploadBtn());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
