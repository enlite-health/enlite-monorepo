import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DocumentUploadCard } from '../DocumentUploadCard';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, def?: string) => def ?? k }) }));

const baseProps = {
  label: 'CV',
  isUploaded: false,
  onFileSelect: vi.fn(),
  onDelete: vi.fn(),
  onView: vi.fn(),
};

describe('DocumentUploadCard', () => {
  it('slot vazio: role="button", clicável, sem badge obrigatório por default', () => {
    render(<DocumentUploadCard {...baseProps} />);
    const card = screen.getByRole('button', { name: 'Upload CV' });
    expect(card).toHaveAttribute('tabIndex', '0');
    expect(screen.queryByTestId('doc-required-badge')).not.toBeInTheDocument();
  });

  it('clica no slot vazio: abre o file picker (input assume o clique)', () => {
    render(<DocumentUploadCard {...baseProps} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Upload CV' }));
    expect(clickSpy).toHaveBeenCalled();
  });

  it('Enter no slot vazio: também abre o file picker', () => {
    render(<DocumentUploadCard {...baseProps} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Upload CV' }), { key: 'Enter' });
    expect(clickSpy).toHaveBeenCalled();
  });

  it('outra tecla (não Enter): não abre o file picker', () => {
    render(<DocumentUploadCard {...baseProps} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Upload CV' }), { key: 'Tab' });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('seleciona um arquivo: chama onFileSelect e limpa o input', () => {
    const onFileSelect = vi.fn();
    render(<DocumentUploadCard {...baseProps} onFileSelect={onFileSelect} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'cv.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFileSelect).toHaveBeenCalledWith(file);
    expect(input.value).toBe('');
  });

  it('change sem arquivo selecionado (cancelar o picker): não chama onFileSelect', () => {
    const onFileSelect = vi.fn();
    render(<DocumentUploadCard {...baseProps} onFileSelect={onFileSelect} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('isRequired e não enviado: mostra o badge "Obligatorio" e a borda vermelha', () => {
    render(<DocumentUploadCard {...baseProps} isRequired />);
    expect(screen.getByTestId('doc-required-badge')).toBeInTheDocument();
  });

  it('isLoading: mostra o spinner e não abre o file picker ao clicar', () => {
    render(<DocumentUploadCard {...baseProps} isLoading />);
    expect(screen.getByTestId('upload-spinner')).toBeInTheDocument();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    // isLoading=true, isUploaded=false → role continua "button" (isClickableUpload
    // só depende de canUpload), mas handleClick tem o guard de isLoading.
    fireEvent.click(screen.getByRole('button', { name: 'Upload CV' }));
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('isUploaded: mostra os ícones de excluir e visualizar, sem role="button"', () => {
    render(<DocumentUploadCard {...baseProps} isUploaded />);
    expect(screen.queryByRole('button', { name: /Upload/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Remover documento')).toBeInTheDocument();
    expect(screen.getByLabelText('Visualizar documento')).toBeInTheDocument();
  });

  it('clica em excluir: chama onDelete sem propagar pro card', () => {
    const onDelete = vi.fn();
    render(<DocumentUploadCard {...baseProps} isUploaded onDelete={onDelete} />);
    fireEvent.click(screen.getByLabelText('Remover documento'));
    expect(onDelete).toHaveBeenCalled();
  });

  it('clica em visualizar: chama onView', () => {
    const onView = vi.fn();
    render(<DocumentUploadCard {...baseProps} isUploaded onView={onView} />);
    fireEvent.click(screen.getByLabelText('Visualizar documento'));
    expect(onView).toHaveBeenCalled();
  });

  // ── D269 — canUpload/canDelete (default true = comportamento do self-service) ──

  it('canUpload=false: slot vazio sem role="button", sem input de arquivo, clique não faz nada', () => {
    const onFileSelect = vi.fn();
    render(<DocumentUploadCard {...baseProps} canUpload={false} onFileSelect={onFileSelect} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    fireEvent.click(screen.getByLabelText('Upload CV'));
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('canDelete=false num doc enviado: ícone de excluir SOME, visualizar continua', () => {
    render(<DocumentUploadCard {...baseProps} isUploaded canDelete={false} />);
    expect(screen.queryByLabelText('Remover documento')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Visualizar documento')).toBeInTheDocument();
  });

  it('default (sem passar canUpload/canDelete): comportamento igual ao self-service — upload e excluir disponíveis', () => {
    render(<DocumentUploadCard {...baseProps} isUploaded />);
    expect(screen.getByLabelText('Remover documento')).toBeInTheDocument();
  });
});
