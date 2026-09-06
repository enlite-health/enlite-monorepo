/**
 * PatientClinicalEditDrawer — REQ-01 (D195): "observações gerais" em textarea grande,
 * com contador e máscara do Clarity; o PATCH manda só o que mudou.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { patientDetailFixture, patientDetailMinimal } from '../../__tests__/patientDetailFixture';

const translations = ptBR as Record<string, any>;
function t(key: string, optsOrDefault?: any): string {
  let current: any = translations;
  for (const part of key.split('.')) current = current?.[part];
  if (typeof current === 'string') {
    if (typeof optsOrDefault === 'object' && optsOrDefault !== null) {
      return current.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => optsOrDefault[k] ?? _);
    }
    return current;
  }
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  if (typeof optsOrDefault === 'object' && typeof optsOrDefault?.defaultValue === 'string') return optsOrDefault.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const updatePatientSection = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { updatePatientSection: (...a: unknown[]) => updatePatientSection(...a) },
}));

// Spec 016 F3: a seção de diagnóstico vive dentro deste drawer — mockada aqui porque nenhum
// teste deste arquivo precisa do fetch real (o próprio arquivo de testes da seção já cobre isso).
const searchTerminology = vi.fn();
vi.mock('@infrastructure/http/AdminTerminologyApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/http/AdminTerminologyApiService')>();
  return {
    TerminologyUnavailableError: actual.TerminologyUnavailableError,
    AdminTerminologyApiService: { search: (...a: unknown[]) => searchTerminology(...a) },
  };
});
const createDiagnosis = vi.fn();
vi.mock('@infrastructure/http/AdminDiagnosisApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/http/AdminDiagnosisApiService')>();
  return {
    DiagnosisApiError: actual.DiagnosisApiError,
    AdminDiagnosisApiService: {
      create: (...a: unknown[]) => createDiagnosis(...a),
      promote: vi.fn(),
      deactivate: vi.fn(),
    },
  };
});

import { PatientClinicalEditDrawer, GENERAL_NOTES_MAX } from '../PatientClinicalEditDrawer';

describe('PatientClinicalEditDrawer — observações gerais (REQ-01)', () => {
  beforeEach(() => { updatePatientSection.mockReset().mockResolvedValue({ id: 'x' }); });

  // 05/09 (Gabriel): 4 linhas, não 8 — o texto é quase sempre curto ou vazio, e a caixa grande
  // empurrava os selects para fora da tela; `resize-y` deixa crescer quando precisar.
  it('renderiza um TEXTAREA (não input de uma linha) com 4 linhas, teto e valor atual', () => {
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    const ta = screen.getByTestId('pce-comments');
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta).toHaveAttribute('rows', '4');
    expect(ta).toHaveAttribute('maxlength', String(GENERAL_NOTES_MAX));
    expect(ta).toHaveValue('TDAH severo');
    expect(screen.getByText(/Observações gerais/)).toBeInTheDocument();
  });

  it('contador acompanha o que é digitado', () => {
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pce-comments-counter').textContent).toBe(`11/${GENERAL_NOTES_MAX} caracteres`);
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'linha 1\nlinha 2' } });
    expect(screen.getByTestId('pce-comments-counter').textContent).toBe(`15/${GENERAL_NOTES_MAX} caracteres`);
  });

  // lex C1.1 — trava: remover o atributo deixa este teste vermelho.
  it('o wrapper do textarea leva data-clarity-mask="True"', () => {
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pce-comments').parentElement).toHaveAttribute('data-clarity-mask', 'True');
  });

  it('salvar manda SÓ o campo alterado, com as quebras de linha, e chama onSaved', async () => {
    const onSaved = vi.fn();
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'Crisis: llamar a la madre.\nEvitar ruidos.' } });
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    expect(updatePatientSection).toHaveBeenCalledWith(patientDetailFixture.id, 'clinical', {
      additionalComments: 'Crisis: llamar a la madre.\nEvitar ruidos.',
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('apagar o texto manda null (limpar é uma edição)', async () => {
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patientDetailFixture.id, 'clinical', { additionalComments: null }));
  });

  it('sem mudança não chama a API e fecha', async () => {
    const onClose = vi.fn();
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1500 });
    expect(updatePatientSection).not.toHaveBeenCalled();
  });

  it('erro da API aparece na tela sem o texto clínico no erro exibido vindo da mensagem genérica', async () => {
    updatePatientSection.mockRejectedValueOnce(new Error('Failed to update patient section'));
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'novo' } });
    fireEvent.click(screen.getByTestId('pce-save'));
    expect(await screen.findByText('Failed to update patient section')).toBeInTheDocument();
  });

  it('erro sem instância de Error cai no fallback traduzido (saveError)', async () => {
    updatePatientSection.mockRejectedValueOnce('boom, não é Error');
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'novo' } });
    fireEvent.click(screen.getByTestId('pce-save'));
    expect(await screen.findByText('Erro ao salvar')).toBeInTheDocument();
  });

  it('Escape fecha o drawer (chama onClose após a transição)', async () => {
    const onClose = vi.fn();
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1500 });
  });

  it('tecla diferente de Escape não fecha o drawer', () => {
    const onClose = vi.fn();
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('altera dispositivo (multi-select do catálogo), dependência, tipo de serviço e os 3 selects tri-state — manda tudo no payload; especialidade NÃO existe mais (US-B8)', async () => {
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    const drawer = screen.getByTestId('patient-clinical-edit-drawer');
    expect(screen.queryByTestId('pce-specialty')).not.toBeInTheDocument();
    expect(drawer.textContent).not.toMatch(/Especialidade|ICHOM/);

    // US-B4: dispositivo é multi-select de códigos do catálogo (HOME + SCHOOL), nunca texto livre
    fireEvent.click(drawer.querySelector('#pce-device button') as HTMLElement);
    fireEvent.click(screen.getByText('Domiciliar'));
    fireEvent.click(screen.getByText('Escolar'));
    fireEvent.change(screen.getByTestId('pce-dependency'), { target: { value: 'MODERATE' } });
    // hasJudicialProtection: false → true (strToBool 'true')
    fireEvent.change(screen.getByTestId('pce-hasJudicialProtection'), { target: { value: 'true' } });
    // hasCud: true → false (strToBool 'false')
    fireEvent.change(screen.getByTestId('pce-hasCud'), { target: { value: 'false' } });
    // hasConsent: true → '' (tri-state "unset", strToBool cai no branch `return null` — linhas 56-57)
    fireEvent.change(screen.getByTestId('pce-hasConsent'), { target: { value: '' } });
    // serviceType: ['AT'] → ['AT', 'CAREGIVER'] via MultiSelect (abre pelo botão com o valor atual)
    fireEvent.click(screen.getByText('Acompanhante Terapêutico'));
    fireEvent.click(screen.getByText('Cuidador'));

    fireEvent.click(screen.getByTestId('pce-save'));

    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
    expect(updatePatientSection).toHaveBeenCalledWith(patientDetailFixture.id, 'clinical', {
      deviceTypes: ['HOME', 'SCHOOL'],
      dependencyLevel: 'MODERATE',
      serviceType: ['AT', 'CAREGIVER'],
      hasJudicialProtection: true,
      hasCud: false,
      hasConsent: null,
    });
  });

  it('paciente mínimo (todos os campos vazios/null): sem mudança não chama a API — cobre os defaults `?? null`/`?? []`/boolToStr(null)', async () => {
    const onClose = vi.fn();
    render(<PatientClinicalEditDrawer patient={patientDetailMinimal} onClose={onClose} onSaved={vi.fn()} />);
    // os 3 tri-state ficam '' (unset) por default — confirma antes de salvar
    expect(screen.getByTestId('pce-hasJudicialProtection')).toHaveValue('');
    expect(screen.getByTestId('pce-hasCud')).toHaveValue('');
    expect(screen.getByTestId('pce-hasConsent')).toHaveValue('');
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1500 });
    expect(updatePatientSection).not.toHaveBeenCalled();
  });

  // ── D211.2: instruções de emergência ──
  it('instruções de emergência: textarea com máscara, contador, e salvar manda SÓ esse campo', async () => {
    render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    const ta = screen.getByTestId('pce-emergency');
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta).toHaveValue('Llamar al 107 y avisar a la madre');
    expect(ta).not.toBeDisabled();
    expect(ta.parentElement).toHaveAttribute('data-clarity-mask', 'True');
    fireEvent.change(ta, { target: { value: 'Nuevo protocolo\nLínea 2' } });
    expect(screen.getByTestId('pce-emergency-counter').textContent).toBe(`23/${GENERAL_NOTES_MAX} caracteres`);
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patientDetailFixture.id, 'clinical', { emergencyInstructions: 'Nuevo protocolo\nLínea 2' }));
  });

  it('redigido pelo backend: o campo vem desabilitado e NUNCA entra no PATCH (não há valor real para preservar)', async () => {
    render(<PatientClinicalEditDrawer patient={{ ...patientDetailFixture, emergencyInstructions: null, emergencyInstructionsRedacted: true }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pce-emergency')).toBeDisabled();
    fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'novo' } });
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patientDetailFixture.id, 'clinical', { additionalComments: 'novo' }));
  });

  it('spec 012: deviceTypes ausente na ficha → conjunto vazio; escolher HOME manda deviceTypes; erro não-Error → mensagem genérica', async () => {
    updatePatientSection.mockRejectedValueOnce('x');
    render(<PatientClinicalEditDrawer patient={{ ...patientDetailMinimal, deviceTypes: undefined as never }} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('patient-clinical-edit-drawer').querySelector('#pce-device button') as HTMLElement);
    fireEvent.click(screen.getByText('Domiciliar'));
    fireEvent.click(screen.getByTestId('pce-save'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith(patientDetailMinimal.id, 'clinical', { deviceTypes: ['HOME'] }));
    expect(await screen.findByTestId('pce-error')).toHaveTextContent('Erro ao salvar');
  });

  // ── 05/09 (Gabriel): o drawer reorganizado ─────────────────────────────────────────────
  describe('disposição (05/09): sem texto livre, quatro seções, mais largo', () => {
    it('o campo livre "Hipótese Diagnóstica - CID" NÃO existe mais, e a fixture COM valor não o envia no PATCH', async () => {
      expect(patientDetailFixture.diagnosis).toBeTruthy();
      render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
      expect(screen.queryByTestId('pce-diagnosis')).not.toBeInTheDocument();
      const drawer = screen.getByTestId('patient-clinical-edit-drawer');
      expect(drawer.textContent).not.toMatch(/Hipótese Diagnóstica/);
      // A sigla só sobrevive na atribuição da OMS (cláusula 1.3 da licença) — em NENHUM rótulo ou título.
      const labelsAndHeadings = Array.from(drawer.querySelectorAll('label, [role="heading"]')).map((e) => e.textContent).join(' | ');
      expect(labelsAndHeadings).not.toMatch(/CID|CIE/);
      expect(screen.getByTestId('who-attribution').textContent).toMatch(/CID-11/);
      fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'só isto' } });
      fireEvent.click(screen.getByTestId('pce-save'));
      await waitFor(() => expect(updatePatientSection).toHaveBeenCalledTimes(1));
      expect(updatePatientSection.mock.calls[0][2]).not.toHaveProperty('diagnosis');
    });

    it('quatro seções nomeadas, na ordem: Patologia → Perfil clínico → Documentação → Observações', () => {
      render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
      const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
      expect(headings).toEqual(['Patologia', 'Perfil clínico', 'Documentação', 'Observações']);
      // a busca estruturada mora na seção Patologia; os textos longos, na última
      expect(screen.getByTestId('pce-section-pathology')).toContainElement(screen.getByTestId('icd-search-input'));
      expect(screen.getByTestId('pce-section-notes')).toContainElement(screen.getByTestId('pce-comments'));
      expect(screen.getByTestId('pce-section-notes')).toContainElement(screen.getByTestId('pce-emergency'));
      // o input de busca perdeu o <label for> e ganhou o título da seção como nome acessível
      const input = screen.getByTestId('icd-search-input');
      expect(input).toHaveAttribute('aria-labelledby', 'pce-section-pathology');
      expect(document.getElementById('pce-section-pathology')).toHaveTextContent('Patologia');
    });

    it('largura 3xl e corpo rolável', () => {
      render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
      const drawer = screen.getByTestId('patient-clinical-edit-drawer');
      expect(drawer.className).toMatch(/\bmax-w-3xl\b/);
      expect((drawer.querySelector('form') as HTMLElement).className).toMatch(/\boverflow-y-auto\b/);
    });

    it('rótulos compactos (12px, cor primária) e NENHUM "(opcional)" — todos os campos são opcionais', () => {
      render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
      const drawer = screen.getByTestId('patient-clinical-edit-drawer');
      expect(drawer.textContent).not.toMatch(/\(opcional\)/);
      const labels = Array.from(drawer.querySelectorAll('label'));
      expect(labels.length).toBeGreaterThanOrEqual(8);
      for (const l of labels) expect(l.className).toMatch(/text-\[12px\]/);
    });
  });

  // ── Spec 014 US-D4 (lex D4 AUTORIZADO): drawer não perde trabalho ──────────────────────
  describe('confirmação ao fechar com mudanças (US-D4)', () => {
    it('SEM mudança → Escape fecha direto', () => {
      render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
    });

    it('COM mudança (observações) → Escape abre confirmação; "Seguir editando" preserva o valor', () => {
      render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'F32' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
      fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
      expect(screen.getByTestId('pce-comments')).toHaveValue('F32');
    });

    it('"Descartar cambios" fecha de verdade', async () => {
      const onClose = vi.fn();
      render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('pce-comments'), { target: { value: 'F32' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(screen.getByTestId('discard-changes-discard'));
      await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1000 });
    });
  });

  // ── Spec 016 F3: a seção de diagnóstico é fora do react-hook-form — o refetch do pai (onSaved)
  // só dispara ao FECHAR o drawer (nunca a cada diagnóstico), porque `PatientDetailPage` desmonta
  // a ficha inteira (skeleton) enquanto `isLoading` — chamar onSaved por ação fechava o drawer
  // sozinho no meio da edição (achado medido nesta sessão, e2e F3).
  describe('diagnóstico estruturado (spec 016 F3) — refetch adiado até o drawer fechar', () => {
    it('escolhe um diagnóstico (POST) e fecha sem tocar em mais nada → onSaved dispara (diagnosesChangedRef)', async () => {
      searchTerminology.mockResolvedValue([{ uri: 'u1', title: 'Esquizofrenia' }]);
      createDiagnosis.mockResolvedValue({ id: 'd1', uri: 'u1', title: 'Esquizofrenia', isPrimary: false, source: 'PANEL', active: true });
      const onSaved = vi.fn();
      const onClose = vi.fn();
      render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={onSaved} />);

      fireEvent.change(screen.getByTestId('icd-search-input'), { target: { value: 'esquiso' } });
      const option = await screen.findByTestId('icd-search-option-0', {}, { timeout: 3000 });
      fireEvent.click(option);
      await waitFor(() => expect(createDiagnosis).toHaveBeenCalledTimes(1));
      await screen.findByTestId('diagnosis-chip-d1');

      // Fecha sem tocar em nenhum outro campo — não passa pelo onSubmit do form.
      fireEvent.click(screen.getByTestId('patient-clinical-edit-backdrop'));
      await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1500 });
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(updatePatientSection).not.toHaveBeenCalled();
    });

    it('sem escolher nenhum diagnóstico, fechar NÃO chama onSaved (diagnosesChangedRef continua false)', async () => {
      const onSaved = vi.fn();
      const onClose = vi.fn();
      render(<PatientClinicalEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={onSaved} />);
      fireEvent.click(screen.getByTestId('patient-clinical-edit-backdrop'));
      await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1500 });
      expect(onSaved).not.toHaveBeenCalled();
    });
  });
});
