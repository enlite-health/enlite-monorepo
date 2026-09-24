/**
 * VacancyFormSection — ramos residuais (spec 028, cobertura 100% do arquivo).
 *
 * Depois de `.prefill`, `.coverage`, `.defense` e `.validationBanner`, restam
 * ramos que só aparecem quando:
 *   1. `existingVacancy` (modo edit) vem ESPARSA — todo campo opcional
 *      ausente, forçando o lado `?? fallback` de cada linha do `reset({...})`
 *      (o "irmão" do teste `.coverage.test.tsx`, que só cobria o lado
 *      preenchido).
 *   2. Modo `create` SEM nenhum caso selecionado — o efeito de montagem
 *      escreve `CASO {n}` (sem case number) em vez de `CASO {formatCaseNumber}-{n}`.
 *   3. `onValidationFailedFieldsChange` e `onCompleteChange` — `VacancyModal`
 *      nunca repassa esses 2 callbacks (não são prop dela), então só um
 *      render DIRETO de `VacancyFormSection` (bypassando o Modal) exercita o
 *      ramo em que eles EXISTEM e são chamados (`cb?.(...)`, os únicos 2
 *      lugares do arquivo que os leem).
 */
import { useEffect, useRef, useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const { getVacancyById, updateVacancy, updateVacancyMeetLinks } = vi.hoisted(() => ({
  getVacancyById: vi.fn(),
  updateVacancy: vi.fn().mockResolvedValue({}),
  updateVacancyMeetLinks: vi.fn().mockResolvedValue({}),
}));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getCasesForSelect: vi.fn().mockResolvedValue([]),
    getVacancyById,
    getPatientById: vi.fn().mockResolvedValue(null),
    listPatientAddresses: vi.fn().mockResolvedValue([]),
    getNextVacancyNumber: vi.fn().mockResolvedValue(321),
    createVacancy: vi.fn().mockResolvedValue({ id: 'x' }),
    updateVacancy,
    updateVacancyMeetLinks,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

import { VacancyModal } from '../VacancyModal';
import { VacancyFormSection } from '../VacancyFormSection';

// ── 1. Modo edit, existingVacancy ESPARSA — lado `?? fallback` do reset() ──

describe('VacancyFormSection — modo edit, vaga esparsa (só `id`, resto ausente)', () => {
  beforeEach(() => {
    getVacancyById.mockResolvedValue({
      id: 'vac-sparse-1',
      // Tudo o resto ausente/undefined — cada `existingVacancy.X ?? fallback`
      // do reset() cai no fallback (D183-safe: não é `null` em produção, mas
      // o optional chaining do componente já defende os dois formatos).
    });
  });

  it('reset() não lança com vaga esparsa; campos caem nos fallbacks (status default, sem crash)', async () => {
    render(
      <MemoryRouter>
        <VacancyModal mode="edit" vacancyId="vac-sparse-1" isOpen onClose={vi.fn()} onSuccess={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('vacancy-form')).toBeInTheDocument());
    // Sem patient_id no seed → `flow.selectCase` nunca dispara → case-number-display
    // fica "—" (selectedCaseNumber null) — prova que o componente não quebrou
    // mesmo com a vaga inteira esparsa.
    await waitFor(() => expect(screen.getByTestId('case-number-display')).toHaveTextContent('—'));
    // required_professions ?? [] → nenhum checkbox marcado.
    expect(screen.getByTestId('profession-checkbox-AT')).not.toBeChecked();
    // providers_needed ?? 1 → fallback numérico.
    expect(screen.getByTestId('providers-needed-input')).toHaveValue(1);
    // meet_link_1 ?? '' → vazio.
    expect(screen.getByTestId('meet-link-0')).toHaveValue('');
  });
});

// ── 2. Modo create, NENHUM caso selecionado — título vira "CASO {n}" ───────

describe('VacancyFormSection — modo create, nenhum caso selecionado no mount', () => {
  it('efeito de montagem não lança e não seleciona nenhum caso (cn == null)', async () => {
    render(
      <MemoryRouter>
        <VacancyModal mode="create" isOpen onClose={vi.fn()} onSuccess={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('vacancy-form')).toBeInTheDocument());
    // Nunca selecionamos um caso — o botão de salvar continua desabilitado
    // (patientSelected=false em create), prova de que `selectedCaseNumber`
    // ficou null durante todo o mount (ramo `cn == null` do prefill).
    expect(screen.getByTestId('header-save-btn')).toBeDisabled();
  });
});

// ── 3. onValidationFailedFieldsChange / onCompleteChange — só via render direto ──

function DirectRenderHarness({
  onValidationFailedFieldsChange,
  onCompleteChange,
}: {
  onValidationFailedFieldsChange: (fields: string[]) => void;
  onCompleteChange: (isComplete: boolean) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <>
      <button type="button" data-testid="harness-save" onClick={() => formRef.current?.requestSubmit()}>
        Save
      </button>
      <VacancyFormSection
        mode="create"
        existingVacancy={null}
        selectedCaseNumber={null}
        selectedPatientId={null}
        selectedAddressId={null}
        dependencyLevel={null}
        addresses={[]}
        isLoadingPatient={false}
        patientError={null}
        patientSelected={false}
        formRef={formRef}
        onSubmittingChange={() => {}}
        onSuccess={() => {}}
        selectCase={() => {}}
        selectAddress={() => {}}
        onValidationFailedFieldsChange={onValidationFailedFieldsChange}
        onCompleteChange={onCompleteChange}
      />
    </>
  );
}

describe('VacancyFormSection — callbacks opcionais só lidos por quem renderiza o componente direto (não VacancyModal)', () => {
  it('onCompleteChange(false) chamado no mount; onValidationFailedFieldsChange chamado com os campos no submit inválido', async () => {
    const onValidationFailedFieldsChange = vi.fn();
    const onCompleteChange = vi.fn();

    render(
      <MemoryRouter>
        <DirectRenderHarness
          onValidationFailedFieldsChange={onValidationFailedFieldsChange}
          onCompleteChange={onCompleteChange}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(onCompleteChange).toHaveBeenCalledWith(false));

    await userEvent.click(screen.getByTestId('harness-save'));

    await waitFor(() => expect(onValidationFailedFieldsChange).toHaveBeenCalled());
    const calls = onValidationFailedFieldsChange.mock.calls;
    const fields = calls[calls.length - 1]?.[0];
    expect(Array.isArray(fields)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
  });
});

// ── 4. Submit VÁLIDO com fallback total (selectedPatientId/AddressId/CaseNumber
//    null, tudo vem de `existingVacancy`) — só alcançável renderizando direto,
//    porque `VacancyModal` sempre mantém os 3 em sincronia via `flow.selectCase`. ──

function FullFormHarness({
  mode,
  existingVacancy,
  selectedCaseNumber,
  selectedPatientId,
  selectedAddressId,
  onValidationFailedFieldsChange,
  meetLinkSlot = 0,
}: {
  mode: 'create' | 'edit';
  existingVacancy: any | null;
  selectedCaseNumber: number | null;
  selectedPatientId: string | null;
  selectedAddressId: string | null;
  onValidationFailedFieldsChange?: (fields: string[]) => void;
  meetLinkSlot?: 0 | 1 | 2;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  // `selectedAddressId` só entra DEPOIS do 1º commit — espelha o fluxo real
  // (usuário clica um endereço só depois que o form já montou). Se fosse
  // prop estática desde o 1º render, o efeito "Initialize form" (que roda
  // DEPOIS do efeito de sync `selectedAddressId → patientAddressId` na mesma
  // passada) clobbers de volta pra `''` (reset(DEFAULT_FORM_VALUES) em modo
  // create, ou o próprio `reset({...})` em modo edit rodando com os valores
  // já corretos — mas ainda assim só é seguro fixar depois do mount inicial).
  const [addrId, setAddrId] = useState<string | null>(null);
  useEffect(() => {
    setAddrId(selectedAddressId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <button type="button" data-testid="harness-save" onClick={() => formRef.current?.requestSubmit()}>
        Save
      </button>
      <VacancyFormSection
        mode={mode}
        existingVacancy={existingVacancy}
        selectedCaseNumber={selectedCaseNumber}
        selectedPatientId={selectedPatientId}
        selectedAddressId={addrId}
        dependencyLevel={null}
        addresses={[]}
        isLoadingPatient={false}
        patientError={null}
        patientSelected
        formRef={formRef}
        onSubmittingChange={() => {}}
        onSuccess={() => {}}
        selectCase={() => {}}
        selectAddress={() => {}}
        onValidationFailedFieldsChange={onValidationFailedFieldsChange}
      />
      <input data-testid="meet-slot-marker" readOnly value={String(meetLinkSlot)} />
    </>
  );
}

async function fillMinimumAndSubmit(meetLinkSlot: 0 | 1 | 2 = 0) {
  await userEvent.click(await screen.findByTestId('profession-checkbox-AT'));
  const addSlotBtn = (await screen.findAllByLabelText('admin.vacancyModal.scheduleSlotsLabel'))[0];
  await userEvent.click(addSlotBtn);
  await userEvent.type(
    await screen.findByTestId(`meet-link-${meetLinkSlot}`),
    'https://meet.google.com/abc-defg-hij',
  );
  await userEvent.click(screen.getByTestId('harness-save'));
}

describe('VacancyFormSection — submit edit direto com selectedPatientId/AddressId/CaseNumber null (fallback pra existingVacancy)', () => {
  beforeEach(() => {
    updateVacancy.mockClear();
    updateVacancyMeetLinks.mockClear();
  });

  it('updateVacancy recebe patient_id/patient_address_id/case_number da existingVacancy (nunca de selectedX, que vieram null)', async () => {
    const onValidationFailedFieldsChange = vi.fn();
    render(
      <MemoryRouter>
        <FullFormHarness
          mode="edit"
          existingVacancy={{
            id: 'vac-fallback-1',
            title: 'CASO 555-1',
            patient_id: 'p-fallback',
            patient_address_id: 'addr-fallback',
            case_number: 555,
          }}
          selectedCaseNumber={null}
          selectedPatientId={null}
          selectedAddressId={null}
          onValidationFailedFieldsChange={onValidationFailedFieldsChange}
          meetLinkSlot={1}
        />
      </MemoryRouter>,
    );

    // Slot 1 (índice 1) preenchido, slot 0 fica vazio — cobre o `|| null` do
    // slot 0 em `meetLinksPayload` (a validação Zod só exige QUALQUER slot válido).
    await fillMinimumAndSubmit(1);

    await waitFor(() => expect(updateVacancy).toHaveBeenCalled());
    expect(updateVacancy).toHaveBeenCalledWith(
      'vac-fallback-1',
      expect.objectContaining({
        patient_id: 'p-fallback',
        patient_address_id: 'addr-fallback',
        case_number: 555,
      }),
    );
    // Submit válido → onSubmit (não onValidationError) roda; a única leitura de
    // `onValidationFailedFieldsChange` DENTRO de onSubmit é o reset pra `[]`.
    expect(onValidationFailedFieldsChange).toHaveBeenCalledWith([]);

    const meetLinksCalls = updateVacancyMeetLinks.mock.calls;
    const meetLinksArg = meetLinksCalls[meetLinksCalls.length - 1]?.[1];
    expect(meetLinksArg[0]).toBeNull(); // slot 0 vazio → `.trim() || null`
    expect(meetLinksArg[1]).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('case_number cai no `null` final quando NEM selectedCaseNumber NEM existingVacancy.case_number existem', async () => {
    render(
      <MemoryRouter>
        <FullFormHarness
          mode="edit"
          existingVacancy={{
            id: 'vac-no-case-1',
            title: 'Vaga sem número de caso',
            patient_id: 'p-no-case',
            patient_address_id: 'addr-no-case',
            // Sem `case_number` — o `??` externo (selectedCaseNumber) e o
            // interno (existingVacancy?.case_number) ficam os dois null.
          }}
          selectedCaseNumber={null}
          selectedPatientId={null}
          selectedAddressId={null}
        />
      </MemoryRouter>,
    );

    await fillMinimumAndSubmit(0);

    await waitFor(() => expect(updateVacancy).toHaveBeenCalled());
    expect(updateVacancy).toHaveBeenCalledWith(
      'vac-no-case-1',
      expect.objectContaining({ case_number: null }),
    );
  });
});

describe('VacancyFormSection — submit create direto: createVacancy resolve string crua (sem `.id`)', () => {
  beforeEach(() => {
    updateVacancyMeetLinks.mockClear();
  });

  it('vacancyId cai no fallback `(result as unknown as string)` quando result não tem `.id`', async () => {
    const { AdminApiService } = await import('@infrastructure/http/AdminApiService');
    (AdminApiService.createVacancy as any).mockResolvedValueOnce('created-raw-id');

    render(
      <MemoryRouter>
        <FullFormHarness
          mode="create"
          existingVacancy={null}
          selectedCaseNumber={999}
          selectedPatientId="p-create"
          selectedAddressId="addr-create"
        />
      </MemoryRouter>,
    );

    await fillMinimumAndSubmit(0);

    await waitFor(() => expect(updateVacancyMeetLinks).toHaveBeenCalled());
    // Se o fallback não tivesse rodado, `vacancyId` seria `undefined` (de
    // `(result as any)?.id` numa string) — a chamada provaria isso passando
    // `undefined` em vez do id cru.
    expect(updateVacancyMeetLinks).toHaveBeenCalledWith(
      'created-raw-id',
      expect.any(Array),
    );
  });
});

describe('VacancyFormSection — modo create, caso JÁ selecionado no primeiro mount (cn != null no efeito de montagem)', () => {
  it('título usa formatCaseNumber já na 1ª renderização (sem esperar troca de caso)', async () => {
    const { AdminApiService } = await import('@infrastructure/http/AdminApiService');
    (AdminApiService.createVacancy as any).mockClear();
    (AdminApiService.createVacancy as any).mockResolvedValue({ id: 'new-vac-mounted' });

    render(
      <MemoryRouter>
        <FullFormHarness
          mode="create"
          existingVacancy={null}
          selectedCaseNumber={999}
          selectedPatientId="p-mounted"
          selectedAddressId="addr-mounted"
        />
      </MemoryRouter>,
    );

    await fillMinimumAndSubmit(0);

    await waitFor(() => expect(AdminApiService.createVacancy).toHaveBeenCalled());
    const createCalls = (AdminApiService.createVacancy as any).mock.calls;
    const payload = createCalls[createCalls.length - 1]?.[0];
    // formatCaseNumber(999) === '999' (< 1000, legado) — confere que o efeito
    // de montagem (cn != null desde o 1º render) escreveu o título formatado,
    // não o "CASO {n}" sem case number do ramo `cn == null`.
    expect(payload.title).toMatch(/^CASO 999-\d+$/);
  });
});
