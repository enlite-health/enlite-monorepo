/**
 * FamiliaresCard — lista por LINHA (padrão do EquipeTratanteCard): "Nuevo" abre o drawer de UM
 * familiar em branco; lápis abre o mesmo drawer preenchido; lixeira pede confirmação e só então
 * desativa; abertura automática pelo checklist ("falta responsable").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientResponsibleDetail } from '@domain/entities/PatientDetail';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return cur;
  if (typeof opts === 'string') return opts;
  if (typeof opts === 'object' && typeof opts?.defaultValue === 'string') return opts.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const api = { createResponsible: vi.fn(), updateResponsible: vi.fn(), deactivateResponsible: vi.fn(), markEmergencyContact: vi.fn(), unmarkEmergencyContact: vi.fn() };
vi.mock('@infrastructure/http/AdminPatientContactRowsApiService', () => ({
  AdminPatientContactRowsApiService: {
    createResponsible: (...a: unknown[]) => api.createResponsible(...a),
    updateResponsible: (...a: unknown[]) => api.updateResponsible(...a),
    deactivateResponsible: (...a: unknown[]) => api.deactivateResponsible(...a),
    markEmergencyContact: (...a: unknown[]) => api.markEmergencyContact(...a),
    unmarkEmergencyContact: (...a: unknown[]) => api.unmarkEmergencyContact(...a),
  },
}));

import { FamiliaresCard } from '../FamiliaresCard';

const mk = (over: Partial<PatientResponsibleDetail>): PatientResponsibleDetail => ({
  id: 'r1', firstName: 'Luciana', lastName: 'Soto', relationship: 'MOM', phone: '(11) 99852-0481', email: null,
  documentType: null, documentNumber: null, isPrimary: false, displayOrder: 1, source: 'admin_manual', ...over,
});
const A = mk({ id: 'rA', firstName: 'Ana', lastName: 'Primera', isPrimary: false, displayOrder: 1 });
const B = mk({ id: 'rB', firstName: 'Beatriz', lastName: 'Titular', isPrimary: true, displayOrder: 2 });

beforeEach(() => {
  api.createResponsible.mockReset().mockResolvedValue({ id: 'novo' });
  api.updateResponsible.mockReset().mockResolvedValue({ id: 'x' });
  api.deactivateResponsible.mockReset().mockResolvedValue({ id: 'x', active: false, emergencyMarkCleared: false });
  api.markEmergencyContact.mockReset().mockResolvedValue({});
  api.unmarkEmergencyContact.mockReset().mockResolvedValue({});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('FamiliaresCard — Nuevo / lápis / lixeira por linha', () => {
  it('"Nuevo" abre o drawer de UM familiar em BRANCO (título "Novo familiar")', () => {
    render(<FamiliaresCard responsibles={[A, B]} patientId="p1" />);
    expect(screen.queryByTestId('responsible-edit-drawer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('familiares-add'));
    expect(screen.getByTestId('responsible-edit-drawer')).toHaveAttribute('aria-label', t('admin.patients.detail.familyCard.newTitle'));
    expect(screen.getByTestId('responsible-firstName')).toHaveValue('');
    expect(screen.getAllByTestId('responsible-firstName')).toHaveLength(1);
  });

  it('o lápis de uma linha abre o MESMO drawer preenchido com AQUELA linha (e só ela)', () => {
    render(<FamiliaresCard responsibles={[A, B]} patientId="p1" />);
    fireEvent.click(screen.getByTestId('familiares-edit-rB'));
    expect(screen.getByTestId('responsible-edit-drawer')).toHaveAttribute('aria-label', t('admin.patients.detail.familyCard.editTitle'));
    expect(screen.getByTestId('responsible-firstName')).toHaveValue('Beatriz');
    expect(screen.getAllByTestId('responsible-firstName')).toHaveLength(1);
  });

  it('lápis e lixeira são só-ícone: sem texto visível, com title + aria-label traduzidos', () => {
    render(<FamiliaresCard responsibles={[A]} patientId="p1" />);
    const edit = screen.getByTestId('familiares-edit-rA');
    const del = screen.getByTestId('familiares-deactivate-rA');
    expect(edit.textContent).toBe('');
    expect(del.textContent).toBe('');
    expect(edit).toHaveAttribute('aria-label', t('admin.patients.detail.familyCard.editResponsible'));
    expect(edit).toHaveAttribute('title', t('admin.patients.detail.familyCard.editResponsible'));
    expect(del).toHaveAttribute('aria-label', t('admin.patients.detail.familyCard.deactivateResponsible'));
    expect(del).toHaveAttribute('title', t('admin.patients.detail.familyCard.deactivateResponsible'));
  });

  it('a lixeira PEDE CONFIRMAÇÃO: nada é desativado até confirmar; cancelar não chama a API', async () => {
    const onSaved = vi.fn();
    render(<FamiliaresCard responsibles={[A, B]} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('familiares-deactivate-rA'));
    expect(screen.getByTestId('deactivate-responsible-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('deactivate-responsible-name')).toHaveTextContent('Ana Primera');
    expect(api.deactivateResponsible).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(t('admin.patients.detail.familyCard.deactivateConfirmCancel')));
    expect(screen.queryByTestId('deactivate-responsible-confirm')).not.toBeInTheDocument();
    expect(api.deactivateResponsible).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('familiares-deactivate-rA'));
    fireEvent.click(screen.getByTestId('deactivate-responsible-confirm-button'));
    await waitFor(() => expect(api.deactivateResponsible).toHaveBeenCalledWith('p1', 'rA'));
    expect(api.deactivateResponsible).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('deactivate-responsible-confirm')).not.toBeInTheDocument());
  });

  it('desativação que falha NÃO chama onSaved e não finge sucesso (o diálogo segue aberto)', async () => {
    api.deactivateResponsible.mockRejectedValueOnce(new Error('boom'));
    const onSaved = vi.fn();
    render(<FamiliaresCard responsibles={[A]} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('familiares-deactivate-rA'));
    fireEvent.click(screen.getByTestId('deactivate-responsible-confirm-button'));
    await waitFor(() => expect(api.deactivateResponsible).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('deactivate-responsible-error')).toHaveTextContent('Erro ao salvar');
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByTestId('deactivate-responsible-confirm')).toBeInTheDocument();
  });

  it('sem patientId nada abre: Nuevo, lápis e lixeira ficam desabilitados', () => {
    render(<FamiliaresCard responsibles={[A]} />);
    expect(screen.getByTestId('familiares-add')).toBeDisabled();
    expect(screen.getByTestId('familiares-edit-rA')).toBeDisabled();
    expect(screen.getByTestId('familiares-deactivate-rA')).toBeDisabled();
  });
});

describe('FamiliaresCard — abertura automática pelo checklist (RESPONSIBLE)', () => {
  it('sem nenhum familiar → abre o drawer em modo CRIAR', () => {
    render(<FamiliaresCard responsibles={[]} patientId="p1" focusRequest={{ code: 'RESPONSIBLE', token: 1 }} />);
    expect(screen.getByTestId('responsible-edit-drawer')).toHaveAttribute('aria-label', t('admin.patients.detail.familyCard.newTitle'));
    expect(screen.getByTestId('responsible-firstName')).toHaveValue('');
  });

  it('havendo familiares → abre a edição do TITULAR (não da 1ª linha)', () => {
    render(<FamiliaresCard responsibles={[A, B]} patientId="p1" focusRequest={{ code: 'RESPONSIBLE', token: 1 }} />);
    expect(screen.getByTestId('responsible-firstName')).toHaveValue('Beatriz');
  });

  it('havendo familiares e NENHUM titular → abre a edição da 1ª linha', () => {
    render(<FamiliaresCard responsibles={[A, mk({ id: 'rC', firstName: 'Carla', isPrimary: false })]} patientId="p1" focusRequest={{ code: 'RESPONSIBLE', token: 1 }} />);
    expect(screen.getByTestId('responsible-firstName')).toHaveValue('Ana');
  });

  it('pedido de OUTRO código não abre nada', () => {
    render(<FamiliaresCard responsibles={[A]} patientId="p1" focusRequest={{ code: 'COVERAGE', token: 1 }} />);
    expect(screen.queryByTestId('responsible-edit-drawer')).not.toBeInTheDocument();
  });
});

describe('FamiliaresCard — marcador de leitura × botão de emergência', () => {
  it('linha marcada: o marcador "Emergência" (texto) é SEPARADO do botão (só ✕); a não marcada tem só a sirene', () => {
    render(<FamiliaresCard responsibles={[A, B]} patientId="p1" emergencyContactRef={{ kind: 'RESPONSIBLE', id: 'rB' }} />);
    expect(screen.getByTestId('familiares-emergency-marked-rB')).toHaveTextContent(t('admin.patients.detail.externalContactsCard.tableEmergency'));
    const marcado = screen.getByTestId('emergency-mark-RESPONSIBLE-rB');
    expect(marcado.textContent).toBe('');
    expect(screen.getByTestId('familiares-emergency-marked-rB').contains(marcado)).toBe(false);
    expect(screen.queryByTestId('familiares-emergency-marked-rA')).not.toBeInTheDocument();
    expect(screen.getByTestId('emergency-mark-RESPONSIBLE-rA').textContent).toBe('');
  });
});
