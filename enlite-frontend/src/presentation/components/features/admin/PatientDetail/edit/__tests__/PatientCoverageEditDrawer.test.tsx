/**
 * PatientCoverageEditDrawer — spec 012, US-B3: cobertura informada (texto), verificadas
 * (multi-select do CATÁLOGO, i18n com fallback no código) e nº de afiliado, via
 * PATCH /:id/coverage. Só o que mudou vai no payload; opção nova do catálogo aparece no select.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture } from '../../__tests__/patientDetailFixture';

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
const te = (k: string): string => t(`admin.patients.editDrawer.${k}`);

const updatePatientSection = vi.fn();
const listInsuranceProviders = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    updatePatientSection: (...a: unknown[]) => updatePatientSection(...a),
    listInsuranceProviders: (...a: unknown[]) => listInsuranceProviders(...a),
  },
}));

import { PatientCoverageEditDrawer } from '../PatientCoverageEditDrawer';

const patient = { ...patientDetailFixture, insuranceInformed: 'OSDE 210', affiliateId: 'AF-1', insuranceVerifiedCodes: ['OSDE'] };

describe('PatientCoverageEditDrawer', () => {
  beforeEach(() => {
    updatePatientSection.mockReset().mockResolvedValue({ id: patient.id });
    listInsuranceProviders.mockReset().mockResolvedValue([
      { code: 'OSDE', sortOrder: 15 }, { code: 'SWISS_MEDICAL', sortOrder: 28 }, { code: 'NUEVA_OS_E2E', sortOrder: 34 },
    ]);
  });

  it('carrega os valores atuais e o catálogo (opção nova vinda do endpoint aparece, com fallback no código)', async () => {
    const { container } = render(<PatientCoverageEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pcv-name')).toHaveValue('OSDE 210');
    expect(screen.getByTestId('pcv-affiliate')).toHaveValue('AF-1');
    await waitFor(() => expect(listInsuranceProviders).toHaveBeenCalled());
    fireEvent.click(container.querySelector('#pcv-codes button') as HTMLElement);
    expect(await screen.findByText('Swiss Medical')).toBeInTheDocument();
    expect(screen.getByText('NUEVA_OS_E2E')).toBeInTheDocument();
    // o atual já vem marcado
    expect(screen.getByTestId('pcv-codes-selected')).toHaveTextContent('OSDE');
  });

  it('salvar 2 verificadas por código + afiliado manda SÓ o que mudou para a seção coverage', async () => {
    const onSaved = vi.fn();
    const { container } = render(<PatientCoverageEditDrawer patient={patient} onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(listInsuranceProviders).toHaveBeenCalled());
    fireEvent.click(container.querySelector('#pcv-codes button') as HTMLElement);
    fireEvent.click(await screen.findByText('Swiss Medical'));
    fireEvent.change(screen.getByTestId('pcv-affiliate'), { target: { value: 'AF-2' } });
    fireEvent.click(screen.getByTestId('pcv-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'coverage', {
      affiliateId: 'AF-2', insuranceVerifiedCodes: ['OSDE', 'SWISS_MEDICAL'],
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('sem mudança → fecha sem PATCH; limpar nome → null; erro do PATCH → mensagem; catálogo falhando → cai no seed', async () => {
    const onClose = vi.fn();
    listInsuranceProviders.mockRejectedValueOnce(new Error('offline'));
    const { container } = render(<PatientCoverageEditDrawer patient={patient} onClose={onClose} onSaved={vi.fn()} />);
    await waitFor(() => expect(listInsuranceProviders).toHaveBeenCalled());
    fireEvent.click(container.querySelector('#pcv-codes button') as HTMLElement);
    expect(await screen.findByText('Galeno')).toBeInTheDocument(); // seed dos 33
    fireEvent.click(screen.getByTestId('pcv-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updatePatientSection).not.toHaveBeenCalled();

    updatePatientSection.mockRejectedValueOnce(new Error('422 código'));
    fireEvent.change(screen.getByTestId('pcv-name'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('pcv-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'coverage', { healthInsuranceName: null }));
    expect(await screen.findByTestId('pcv-error')).toHaveTextContent('422 código');
    updatePatientSection.mockRejectedValueOnce('x');
    fireEvent.click(screen.getByTestId('pcv-save'));
    await waitFor(() => expect(screen.getByTestId('pcv-error')).toHaveTextContent('Erro ao salvar'));
  });

  it('Escape e o backdrop fecham', () => {
    const onClose = vi.fn();
    render(<PatientCoverageEditDrawer patient={patient} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('patient-coverage-edit-backdrop'));
    expect(screen.getByTestId('patient-coverage-edit-drawer')).toBeInTheDocument();
  });

  it('paciente sem cobertura nenhuma (nulls / codes ausentes): campos vazios; escolher um código manda só os códigos', async () => {
    const { container } = render(<PatientCoverageEditDrawer patient={{ ...patient, insuranceInformed: null, affiliateId: null, insuranceVerifiedCodes: undefined as never }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pcv-name')).toHaveValue('');
    expect(screen.getByTestId('pcv-affiliate')).toHaveValue('');
    await waitFor(() => expect(listInsuranceProviders).toHaveBeenCalled());
    fireEvent.click(container.querySelector('#pcv-codes button') as HTMLElement);
    fireEvent.click(await screen.findByText('Swiss Medical'));
    fireEvent.click(screen.getByTestId('pcv-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'coverage', { insuranceVerifiedCodes: ['SWISS_MEDICAL'] }));
  });

  // ── QA 🟡3 (SUP-B5): a origem ClickUp trava — RED antes do conserto, porque o multi-select
  // marcava TUDO (união) e "desmarcar" GALENO não removia nada de verdade (o PATCH só apagava
  // admin_manual); o operador via sucesso e a cobertura voltava no próximo GET. ──────────────

  const patientWithMixedOrigins = {
    ...patient,
    insuranceVerifiedCodes: ['GALENO', 'OSDE'],
    insuranceVerifiedEntries: [
      { code: 'GALENO', source: 'clickup' },
      { code: 'OSDE', source: 'admin_manual' },
    ],
  };

  it('cobertura de origem ClickUp aparece como chip travado, FORA do multi-select e do payload', async () => {
    listInsuranceProviders.mockResolvedValue([
      { code: 'GALENO', sortOrder: 10 }, { code: 'OSDE', sortOrder: 15 }, { code: 'SWISS_MEDICAL', sortOrder: 28 },
    ]);
    const { container } = render(<PatientCoverageEditDrawer patient={patientWithMixedOrigins} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(listInsuranceProviders).toHaveBeenCalled());

    // GALENO (ClickUp) vira chip travado, com o rótulo "(do ClickUp)" (pt-BR) — NÃO entra no que
    // está "selecionado" pelo multi-select (pcv-codes-selected), que é só OSDE (admin_manual).
    expect(screen.getByTestId('pcv-codes-locked')).toHaveTextContent('Galeno');
    expect(screen.getByTestId('pcv-codes-locked')).toHaveTextContent('(do ClickUp)');
    expect(screen.getByTestId('pcv-codes-selected')).toHaveTextContent('OSDE');
    expect(screen.getByTestId('pcv-codes-selected')).not.toHaveTextContent('Galeno');

    // Abrindo o multi-select, GALENO não vem marcado — não é o multi-select quem o controla.
    fireEvent.click(container.querySelector('#pcv-codes button') as HTMLElement);
    const listbox = await screen.findByRole('listbox');
    const galenoOption = within(listbox).getByRole('option', { name: 'Galeno' });
    expect(galenoOption.getAttribute('aria-selected')).toBe('false');

    // Salvar SEM tocar em nada não manda payload (GALENO nunca esteve no editável, então não há
    // "remoção" a comparar) — prova que ele é inerte para o formulário.
    fireEvent.click(screen.getByTestId('pcv-save'));
    await waitFor(() => expect(updatePatientSection).not.toHaveBeenCalled());
  });

  it('desmarcar um código admin_manual remove SÓ ele do payload — GALENO (ClickUp) nunca entra', async () => {
    listInsuranceProviders.mockResolvedValue([
      { code: 'GALENO', sortOrder: 10 }, { code: 'OSDE', sortOrder: 15 },
    ]);
    const onSaved = vi.fn();
    const { container } = render(<PatientCoverageEditDrawer patient={patientWithMixedOrigins} onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(listInsuranceProviders).toHaveBeenCalled());
    fireEvent.click(container.querySelector('#pcv-codes button') as HTMLElement);
    const listbox = await screen.findByRole('listbox');
    const osdeOption = within(listbox).getByRole('option', { name: 'OSDE' });
    fireEvent.click(osdeOption.querySelector('button') as HTMLElement); // desmarca o único editável
    fireEvent.click(screen.getByTestId('pcv-save'));
    // O payload NUNCA carrega 'GALENO': não é opção do multi-select removê-lo, porque ele nunca
    // esteve no conjunto que o multi-select edita.
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'coverage', { insuranceVerifiedCodes: [] }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('sem insuranceVerifiedEntries (contrato anterior) → trata tudo como editável, comportamento de antes', async () => {
    const legacyPatient = { ...patient, insuranceVerifiedCodes: ['OSDE'], insuranceVerifiedEntries: undefined };
    render(<PatientCoverageEditDrawer patient={legacyPatient} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(listInsuranceProviders).toHaveBeenCalled());
    expect(screen.queryByTestId('pcv-codes-locked')).not.toBeInTheDocument();
    expect(screen.getByTestId('pcv-codes-selected')).toHaveTextContent('OSDE');
  });

  // ── Spec 014 US-D4 (lex D4 AUTORIZADO): drawer não perde trabalho ──────────────────────
  describe('confirmação ao fechar com mudanças (US-D4)', () => {
    it('SEM mudança → Escape fecha direto, sem confirmação', () => {
      render(<PatientCoverageEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
    });

    it('COM mudança (nome) → Escape abre confirmação em vez de fechar', () => {
      render(<PatientCoverageEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('pcv-name'), { target: { value: 'Nueva OS' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
    });

    it('"Seguir editando" mantém o drawer aberto e o valor digitado', () => {
      render(<PatientCoverageEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('pcv-name'), { target: { value: 'Nueva OS' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
      expect(screen.getByTestId('pcv-name')).toHaveValue('Nueva OS');
      expect(screen.getByTestId('patient-coverage-edit-drawer')).toBeInTheDocument();
    });

    it('"Descartar cambios" chama onClose (via o mesmo handleClose com timeout, como antes)', () => {
      vi.useFakeTimers();
      const onClose = vi.fn();
      render(<PatientCoverageEditDrawer patient={patient} onClose={onClose} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('pcv-name'), { target: { value: 'Nueva OS' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(screen.getByTestId('discard-changes-discard'));
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
      vi.advanceTimersByTime(300);
      expect(onClose).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('backdrop e botão X seguem a MESMA régua (dirty → confirmação)', () => {
      render(<PatientCoverageEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('pcv-affiliate'), { target: { value: 'AF-999' } });
      fireEvent.click(screen.getByTestId('patient-coverage-edit-backdrop'));
      expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
      fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
      fireEvent.click(screen.getByLabelText(te('close')));
      expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
    });

    it('SALVAR nunca pergunta, mesmo com mudança pendente', async () => {
      const onSaved = vi.fn();
      render(<PatientCoverageEditDrawer patient={patient} onClose={vi.fn()} onSaved={onSaved} />);
      fireEvent.change(screen.getByTestId('pcv-name'), { target: { value: 'Nueva OS' } });
      fireEvent.click(screen.getByTestId('pcv-save'));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
    });

    it('hint do nº de afiliado aparece no FormField', () => {
      render(<PatientCoverageEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
      expect(screen.getByText(te('affiliateHint'))).toBeVisible();
    });
  });
});
