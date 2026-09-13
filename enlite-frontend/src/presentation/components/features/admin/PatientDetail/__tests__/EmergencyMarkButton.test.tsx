/**
 * EmergencyMarkButton — spec 018, PR-2, US-8, D-A. Sem enforcement ligado (default dos testes,
 * `useActionGate` devolve `{allowed:true}`), o `ActionButton` sempre renderiza — aqui cobrimos o
 * toggle mark/unmark e a chamada certa da API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

const translations = ptBR as Record<string, any>;
function t(key: string): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  return typeof cur === 'string' ? cur : key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const mockMark = vi.fn();
const mockUnmark = vi.fn();
vi.mock('@infrastructure/http/AdminPatientContactRowsApiService', () => ({
  AdminPatientContactRowsApiService: {
    markEmergencyContact: (...a: unknown[]) => mockMark(...a),
    unmarkEmergencyContact: (...a: unknown[]) => mockUnmark(...a),
  },
}));

import { EmergencyMarkButton } from '../EmergencyMarkButton';

describe('EmergencyMarkButton', () => {
  beforeEach(() => { mockMark.mockReset().mockResolvedValue({}); mockUnmark.mockReset().mockResolvedValue({}); });

  it('não marcado: rótulo "marcar"; clicar chama markEmergencyContact com {kind, id} e dispara onChanged', async () => {
    const onChanged = vi.fn();
    render(<EmergencyMarkButton patientId="p1" kind="RESPONSIBLE" contactId="r1" isMarked={false} onChanged={onChanged} />);
    expect(screen.getByTestId('emergency-mark-RESPONSIBLE-r1')).toHaveTextContent(t('admin.patients.editDrawer.markEmergencyContact'));
    fireEvent.click(screen.getByTestId('emergency-mark-RESPONSIBLE-r1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockMark).toHaveBeenCalledWith('p1', { kind: 'RESPONSIBLE', id: 'r1' });
    expect(mockUnmark).not.toHaveBeenCalled();
  });

  it('marcado: rótulo "quitar"; clicar chama unmarkEmergencyContact(patientId) e dispara onChanged', async () => {
    const onChanged = vi.fn();
    render(<EmergencyMarkButton patientId="p1" kind="EXTERNAL" contactId="x1" isMarked onChanged={onChanged} />);
    expect(screen.getByTestId('emergency-mark-EXTERNAL-x1')).toHaveTextContent(t('admin.patients.editDrawer.unmarkEmergencyContact'));
    fireEvent.click(screen.getByTestId('emergency-mark-EXTERNAL-x1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockUnmark).toHaveBeenCalledWith('p1');
    expect(mockMark).not.toHaveBeenCalled();
  });

  it('onChanged NÃO é chamado se a API rejeitar (o botão não finge sucesso); alerta genérico, sem eco de payload', async () => {
    mockMark.mockRejectedValueOnce(new Error('boom'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onChanged = vi.fn();
    render(<EmergencyMarkButton patientId="p1" kind="RESPONSIBLE" contactId="r1" isMarked={false} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('emergency-mark-RESPONSIBLE-r1'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(t('admin.patients.editDrawer.markEmergencyContactError')));
    expect(onChanged).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});
