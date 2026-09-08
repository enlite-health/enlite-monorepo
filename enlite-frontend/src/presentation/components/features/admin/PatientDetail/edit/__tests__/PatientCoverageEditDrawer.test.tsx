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

  it('417 (D301.3b) — contatos de emergência da cobertura: abre com os atuais; adicionar/editar manda a LISTA inteira (trim) na seção coverage; sem mexer, a chave não vai', async () => {
    const onSaved = vi.fn();
    const comContatos = { ...patient, coverageEmergencyContacts: [{ id: 'c1', kind: 'AMBULANCE' as const, name: 'Ambulancia OSDE', phone: '0800-1', sortOrder: 0 }] };
    render(<PatientCoverageEditDrawer patient={comContatos} onClose={vi.fn()} onSaved={onSaved} />);
    expect(screen.getByTestId('pcv-contact-name-0')).toHaveValue('Ambulancia OSDE');
    expect(screen.getByTestId('pcv-contact-phone-0')).toHaveValue('0800-1');
    // Só o afiliado muda → a chave `emergencyContacts` NÃO vai (a lista não foi tocada).
    fireEvent.change(screen.getByTestId('pcv-affiliate'), { target: { value: 'AF-2' } });
    fireEvent.click(screen.getByTestId('pcv-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'coverage', { affiliateId: 'AF-2' }));
    updatePatientSection.mockClear();
    // Adiciona um profissional direto (com espaços) → a lista inteira, com trim.
    fireEvent.click(screen.getByTestId('pcv-contact-add'));
    fireEvent.change(screen.getByTestId('pcv-contact-kind-1'), { target: { value: 'DIRECT_PROFESSIONAL' } });
    fireEvent.change(screen.getByTestId('pcv-contact-name-1'), { target: { value: '  Dra. Pérez  ' } });
    fireEvent.change(screen.getByTestId('pcv-contact-phone-1'), { target: { value: ' 11-5555 ' } });
    fireEvent.click(screen.getByTestId('pcv-save'));
    // O drawer segue aberto (fecha em 300 ms): o afiliado mudado continua no diff, e a lista entra inteira.
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'coverage', {
      affiliateId: 'AF-2',
      emergencyContacts: [
        { kind: 'AMBULANCE', name: 'Ambulancia OSDE', phone: '0800-1' },
        { kind: 'DIRECT_PROFESSIONAL', name: 'Dra. Pérez', phone: '11-5555' },
      ],
    }));
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it('417 — linha inválida (nome vazio) trava o "Salvar"; remover a linha destrava; backend anterior (ausente) começa vazio', async () => {
    const { coverageEmergencyContacts: _c, ...semCampo } = patient as typeof patient & { coverageEmergencyContacts?: unknown };
    render(<PatientCoverageEditDrawer patient={semCampo as typeof patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pcv-contacts-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pcv-contact-add'));
    expect((screen.getByTestId('pcv-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('pcv-contact-name-0'), { target: { value: 'Central' } });
    fireEvent.change(screen.getByTestId('pcv-contact-phone-0'), { target: { value: '107' } });
    expect((screen.getByTestId('pcv-save') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('pcv-contact-remove-0'));
    // Voltou ao estado inicial (vazio): nada mudou → fecha sem PATCH.
    fireEvent.click(screen.getByTestId('pcv-save'));
    await waitFor(() => expect(updatePatientSection).not.toHaveBeenCalled());
  });

  it('417 / gate — `null` (sem `patient_coverage:read`): a lista NÃO é oferecida (aviso no lugar) e nada dela vai no payload', async () => {
    render(<PatientCoverageEditDrawer patient={{ ...patient, coverageEmergencyContacts: null }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pcv-contacts-redacted')).toHaveTextContent(te('coverageContactsRedacted'));
    expect(screen.queryByTestId('pcv-emergency-contacts')).toBeNull();
    fireEvent.change(screen.getByTestId('pcv-affiliate'), { target: { value: 'AF-3' } });
    fireEvent.click(screen.getByTestId('pcv-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'coverage', { affiliateId: 'AF-3' }));
  });

  it('417 — apagar um contato existente manda a lista SEM ele (o servidor substitui a lista inteira); Escape com a lista mexida pede confirmação', async () => {
    const comContatos = { ...patient, coverageEmergencyContacts: [
      { id: 'c1', kind: 'AMBULANCE' as const, name: 'Ambulancia', phone: '0800', sortOrder: 0 },
      { id: 'c2', kind: 'EMERGENCY_CENTER' as const, name: 'Central', phone: '107', sortOrder: 1 },
    ] };
    render(<PatientCoverageEditDrawer patient={comContatos} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('pcv-contact-remove-0'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('discard-changes-confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
    fireEvent.click(screen.getByTestId('pcv-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patient.id, 'coverage', { emergencyContacts: [{ kind: 'EMERGENCY_CENTER', name: 'Central', phone: '107' }] }));
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
