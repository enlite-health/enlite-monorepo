/**
 * `AxonicoDocumentModal` — puramente apresentação, MESMO padrão de `ValidateBatchModal.test.tsx`/
 * `ContestModal.test.tsx`. A fiação de verdade (registrar → enviar encadeado) é testada em
 * `AxonicoSendControl.test.tsx`; aqui só o contrato do modal em si: confirmar desabilitado até
 * digitar, `onConfirm` recebe o valor TRIMADO, e a mensagem de erro por código.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AxonicoDocumentModal } from './AxonicoDocumentModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('AxonicoDocumentModal', () => {
  it('POSITIVO — nasce com o confirmar DESABILITADO (campo vazio)', () => {
    render(<AxonicoDocumentModal isSubmitting={false} errorCode={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-axonico-document-modal-confirm')).toBeDisabled();
  });

  it('POSITIVO — digitar habilita o confirmar; confirmar chama onConfirm com o valor TRIMADO', () => {
    const onConfirm = vi.fn();
    render(<AxonicoDocumentModal isSubmitting={false} errorCode={null} onConfirm={onConfirm} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByTestId('anacare-hours-axonico-document-modal-input'), { target: { value: '  30111222  ' } });
    expect(screen.getByTestId('anacare-hours-axonico-document-modal-confirm')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('anacare-hours-axonico-document-modal-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('30111222');
  });

  it('NEGATIVO — campo só com espaços mantém o confirmar DESABILITADO', () => {
    render(<AxonicoDocumentModal isSubmitting={false} errorCode={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('anacare-hours-axonico-document-modal-input'), { target: { value: '   ' } });
    expect(screen.getByTestId('anacare-hours-axonico-document-modal-confirm')).toBeDisabled();
  });

  it('NEGATIVO — isSubmitting desabilita campo, confirmar e cancelar', () => {
    render(<AxonicoDocumentModal isSubmitting errorCode={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-axonico-document-modal-input')).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-axonico-document-modal-confirm')).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-axonico-document-modal-cancel')).toBeDisabled();
  });

  it('POSITIVO — sem errorCode, o slot de erro não aparece', () => {
    render(<AxonicoDocumentModal isSubmitting={false} errorCode={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('anacare-hours-axonico-document-modal-error')).not.toBeInTheDocument();
  });

  it('NEGATIVO — errorCode de conflito (409) mostra a mensagem de CONFLITO', () => {
    render(<AxonicoDocumentModal isSubmitting={false} errorCode="DocumentoJaRegistradoDivergenteError" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-axonico-document-modal-error')).toHaveTextContent(
      'admin.anacareHours.dayGroup.axonico.documentModal.errorConflict',
    );
  });

  it('NEGATIVO — qualquer outro errorCode mostra a mensagem GENÉRICA de documento inválido (distinta da de conflito)', () => {
    render(<AxonicoDocumentModal isSubmitting={false} errorCode="DocumentoInvalidoError" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-axonico-document-modal-error')).toHaveTextContent(
      'admin.anacareHours.dayGroup.axonico.documentModal.errorInvalid',
    );
  });

  it('POSITIVO — cancelar chama onCancel', () => {
    const onCancel = vi.fn();
    render(<AxonicoDocumentModal isSubmitting={false} errorCode={null} onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('anacare-hours-axonico-document-modal-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
