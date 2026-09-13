/**
 * ResolveAddressModal.test.tsx — spec 019 (D310 item c): cobre o arquivo INTEIRO (100% dos 4
 * eixos), incluindo o que já existia sem teste antes desta rodada (o componente nunca teve
 * suíte própria). Nasce junto da remoção do select de tipo morto (`newAddressType` — o wizard de
 * revisão de vaga não decide mais o parentesco do domicílio; isso é só o PATCH do
 * AdminPatientAddressesController).
 *
 * Cobertura:
 *   - useEffect: sem patient_id não busca endereços (early return); com patient_id busca, e o
 *     catch (erro de rede) esvazia a lista sem quebrar a tela.
 *   - loadingAddresses: spinner enquanto a promise não resolve.
 *   - As 3 variantes do ternário de "sem endereços": patient_id ausente, patient_id presente sem
 *     endereços, e lista com itens (isSelected true/false, address_raw presente/ausente).
 *   - Selecionar existente ↔ abrir form de criação (cada um desmarca o outro).
 *   - canConfirm desabilita o botão nas duas combinações (nenhuma seleção / formatted vazio).
 *   - handleConfirm: os dois ramos do body (patient_address_id vs createAddress), e o
 *     createAddress com/sem address_raw (branch do spread) — SEM `address_type` no payload
 *     (prova negativa: a chave nunca aparece no body enviado a onConfirm).
 *   - onClose (X e Cancelar) e isLoading desabilitando os 3 botões interativos + spinner do
 *     Confirmar.
 *   - item.legacy_address_hint presente/ausente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResolveAddressModal } from './ResolveAddressModal';
import type { PendingAddressReviewItem, PatientAddressRow } from '@domain/entities/PatientAddress';
import type { ResolveAddressBody } from '@infrastructure/http/AdminVacancyAddressApiService';

const mockListPatientAddresses = vi.fn();

vi.mock('@infrastructure/http/AdminVacancyAddressApiService', () => ({
  AdminVacancyAddressApiService: {
    listPatientAddresses: (...args: unknown[]) => mockListPatientAddresses(...args),
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ITEM_WITH_PATIENT: PendingAddressReviewItem = {
  id: 'vac-1',
  case_number: 10,
  vacancy_number: 1,
  title: 'CASO 10-1',
  status: 'PENDING_REVIEW',
  legacy_address_hint: 'Av. Corrientes 1234, CABA',
  patient_id: 'pat-10',
  patient_name: 'Juan Pérez',
  audit_match_type: 'NONE',
  audit_confidence_score: null,
  audit_attempted_match: null,
};

const ITEM_NO_PATIENT: PendingAddressReviewItem = {
  ...ITEM_WITH_PATIENT,
  id: 'vac-2',
  legacy_address_hint: null,
  patient_id: null,
};

const ADDR_WITH_RAW: PatientAddressRow = {
  id: 'addr-1',
  patient_id: 'pat-10',
  address_formatted: 'Florida 100, CABA',
  address_raw: 'Florida 100',
  display_order: 1,
  source: 'admin_review',
  complement: null,
  lat: null,
  lng: null,
};

const ADDR_NO_RAW: PatientAddressRow = {
  id: 'addr-2',
  patient_id: 'pat-10',
  address_formatted: 'Lavalle 200, CABA',
  address_raw: null,
  display_order: 2,
  source: 'admin_review',
  complement: null,
  lat: null,
  lng: null,
};

interface Overrides {
  item?: PendingAddressReviewItem;
  onConfirm?: (body: ResolveAddressBody) => Promise<void>;
  onClose?: () => void;
  isLoading?: boolean;
}

function renderModal({
  item = ITEM_WITH_PATIENT,
  onConfirm = vi.fn().mockResolvedValue(undefined),
  onClose = vi.fn(),
  isLoading = false,
}: Overrides = {}) {
  return { onConfirm, onClose, ...render(
    <ResolveAddressModal item={item} onConfirm={onConfirm} onClose={onClose} isLoading={isLoading} />,
  ) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListPatientAddresses.mockResolvedValue([]);
});

// ── useEffect / busca de endereços existentes ────────────────────────────────

describe('ResolveAddressModal — busca de endereços existentes', () => {
  it('sem patient_id: NÃO busca endereços e mostra "sem endereços" (ramo 1 do ternário)', async () => {
    renderModal({ item: ITEM_NO_PATIENT });
    expect(mockListPatientAddresses).not.toHaveBeenCalled();
    expect(screen.getByText('admin.pendingAddressReview.resolveModal.noAddresses')).toBeInTheDocument();
  });

  it('com patient_id: busca e mostra spinner enquanto carrega', async () => {
    let resolvePromise: (v: PatientAddressRow[]) => void = () => {};
    mockListPatientAddresses.mockReturnValue(new Promise((res) => { resolvePromise = res; }));

    const { container } = renderModal({ item: ITEM_WITH_PATIENT });
    expect(mockListPatientAddresses).toHaveBeenCalledWith('pat-10');
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();

    resolvePromise([]);
    await waitFor(() =>
      expect(screen.getByText('admin.pendingAddressReview.resolveModal.noAddresses')).toBeInTheDocument(),
    );
  });

  it('com patient_id mas 0 endereços: mostra "sem endereços" (ramo 2 do ternário, diferente do ramo 1)', async () => {
    mockListPatientAddresses.mockResolvedValue([]);
    renderModal({ item: ITEM_WITH_PATIENT });
    await waitFor(() =>
      expect(screen.getByText('admin.pendingAddressReview.resolveModal.noAddresses')).toBeInTheDocument(),
    );
  });

  it('erro na busca (catch): esvazia a lista sem quebrar a tela', async () => {
    mockListPatientAddresses.mockRejectedValue(new Error('network down'));
    renderModal({ item: ITEM_WITH_PATIENT });
    await waitFor(() =>
      expect(screen.getByText('admin.pendingAddressReview.resolveModal.noAddresses')).toBeInTheDocument(),
    );
  });

  it('lista endereços: address_raw presente E ausente (os dois ramos do `addr.address_raw &&`)', async () => {
    mockListPatientAddresses.mockResolvedValue([ADDR_WITH_RAW, ADDR_NO_RAW]);
    renderModal({ item: ITEM_WITH_PATIENT });
    await waitFor(() => expect(screen.getByText('Florida 100, CABA')).toBeInTheDocument());
    expect(screen.getByText('Florida 100')).toBeInTheDocument(); // address_raw exibido
    expect(screen.getByText('Lavalle 200, CABA')).toBeInTheDocument();
    expect(screen.queryByText('Lavalle 200')).not.toBeInTheDocument(); // sem address_raw, nada extra
  });
});

// ── Selecionar existente × criar novo (isSelected, mutuamente exclusivos) ────

describe('ResolveAddressModal — seleção de endereço existente e form de criação', () => {
  it('clicar num endereço existente marca isSelected (ícone CheckCircle) e desmarca o form de criação', async () => {
    mockListPatientAddresses.mockResolvedValue([ADDR_WITH_RAW, ADDR_NO_RAW]);
    renderModal({ item: ITEM_WITH_PATIENT });
    await waitFor(() => expect(screen.getByText('Florida 100, CABA')).toBeInTheDocument());

    const btnA = screen.getByText('Florida 100, CABA').closest('button')!;
    const btnB = screen.getByText('Lavalle 200, CABA').closest('button')!;
    fireEvent.click(btnA);
    expect(btnA.className).toContain('border-primary');
    expect(btnB.className).toContain('border-slate-200'); // não selecionado

    fireEvent.click(btnB);
    expect(btnB.className).toContain('border-primary');
    expect(btnA.className).toContain('border-slate-200');
  });

  it('abrir "criar novo" some com o botão e mostra o form; selecionar existente depois fecha o form de novo', async () => {
    mockListPatientAddresses.mockResolvedValue([ADDR_WITH_RAW]);
    renderModal({ item: ITEM_WITH_PATIENT });
    await waitFor(() => expect(screen.getByText('Florida 100, CABA')).toBeInTheDocument());

    fireEvent.click(screen.getByText('admin.pendingAddressReview.resolveModal.createNew'));
    expect(screen.getByPlaceholderText('admin.pendingAddressReview.resolveModal.addressFormatted')).toBeInTheDocument();
    expect(screen.queryByText('admin.pendingAddressReview.resolveModal.createNew')).not.toBeInTheDocument();

    // selecionar um existente enquanto o form de criação está aberto fecha o form (setShowCreateForm(false))
    fireEvent.click(screen.getByText('Florida 100, CABA').closest('button')!);
    expect(
      screen.queryByPlaceholderText('admin.pendingAddressReview.resolveModal.addressFormatted'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('admin.pendingAddressReview.resolveModal.createNew')).toBeInTheDocument();
  });

  it('sem item.patient_id: não mostra o botão "criar novo" (guard `item.patient_id &&`)', () => {
    renderModal({ item: ITEM_NO_PATIENT });
    expect(screen.queryByText('admin.pendingAddressReview.resolveModal.createNew')).not.toBeInTheDocument();
  });
});

// ── legacy_address_hint ──────────────────────────────────────────────────────

describe('ResolveAddressModal — endereço legado (informativo)', () => {
  it('exibe o hint quando presente', async () => {
    renderModal({ item: ITEM_WITH_PATIENT });
    expect(screen.getByText('Av. Corrientes 1234, CABA')).toBeInTheDocument();
    // Aguarda o useEffect (listPatientAddresses) assentar — evita o state update fora de act().
    await waitFor(() => expect(mockListPatientAddresses).toHaveBeenCalled());
  });

  it('não exibe nada quando ausente', () => {
    renderModal({ item: ITEM_NO_PATIENT });
    expect(screen.queryByText('Av. Corrientes 1234, CABA')).not.toBeInTheDocument();
  });
});

// ── canConfirm / botão Confirmar ─────────────────────────────────────────────

describe('ResolveAddressModal — canConfirm desabilita o Confirmar', () => {
  it('sem seleção nem form de criação: Confirmar desabilitado', () => {
    renderModal({ item: ITEM_NO_PATIENT });
    const confirmBtn = screen.getByText('admin.pendingAddressReview.resolveModal.confirm').closest('button')!;
    expect(confirmBtn).toBeDisabled();
  });

  it('form de criação aberto com address_formatted vazio (item com patient_id): Confirmar desabilitado', async () => {
    mockListPatientAddresses.mockResolvedValue([]);
    renderModal({ item: ITEM_WITH_PATIENT });
    await waitFor(() =>
      expect(screen.getByText('admin.pendingAddressReview.resolveModal.createNew')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('admin.pendingAddressReview.resolveModal.createNew'));
    const confirmBtn = screen.getByText('admin.pendingAddressReview.resolveModal.confirm').closest('button')!;
    expect(confirmBtn).toBeDisabled();
  });

  it('form de criação com address_formatted preenchido: Confirmar habilitado', async () => {
    mockListPatientAddresses.mockResolvedValue([]);
    renderModal({ item: ITEM_WITH_PATIENT });
    await waitFor(() =>
      expect(screen.getByText('admin.pendingAddressReview.resolveModal.createNew')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('admin.pendingAddressReview.resolveModal.createNew'));
    fireEvent.change(
      screen.getByPlaceholderText('admin.pendingAddressReview.resolveModal.addressFormatted'),
      { target: { value: 'Corrientes 500' } },
    );
    const confirmBtn = screen.getByText('admin.pendingAddressReview.resolveModal.confirm').closest('button')!;
    expect(confirmBtn).not.toBeDisabled();
  });

  it('existente selecionado: Confirmar habilitado', async () => {
    mockListPatientAddresses.mockResolvedValue([ADDR_WITH_RAW]);
    renderModal({ item: ITEM_WITH_PATIENT });
    await waitFor(() => expect(screen.getByText('Florida 100, CABA')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Florida 100, CABA').closest('button')!);
    const confirmBtn = screen.getByText('admin.pendingAddressReview.resolveModal.confirm').closest('button')!;
    expect(confirmBtn).not.toBeDisabled();
  });
});

// ── handleConfirm — os dois ramos do body, SEM address_type ─────────────────

describe('ResolveAddressModal — handleConfirm', () => {
  it('endereço existente selecionado → onConfirm({ patient_address_id })', async () => {
    mockListPatientAddresses.mockResolvedValue([ADDR_WITH_RAW]);
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderModal({ item: ITEM_WITH_PATIENT, onConfirm });
    await waitFor(() => expect(screen.getByText('Florida 100, CABA')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Florida 100, CABA').closest('button')!);

    fireEvent.click(screen.getByText('admin.pendingAddressReview.resolveModal.confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ patient_address_id: 'addr-1' }));
  });

  it('criar novo SEM address_raw → createAddress só com address_formatted, sem address_type nem address_raw', async () => {
    mockListPatientAddresses.mockResolvedValue([]);
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderModal({ item: ITEM_WITH_PATIENT, onConfirm });
    await waitFor(() =>
      expect(screen.getByText('admin.pendingAddressReview.resolveModal.createNew')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('admin.pendingAddressReview.resolveModal.createNew'));
    fireEvent.change(
      screen.getByPlaceholderText('admin.pendingAddressReview.resolveModal.addressFormatted'),
      { target: { value: '  Corrientes 500  ' } },
    );

    fireEvent.click(screen.getByText('admin.pendingAddressReview.resolveModal.confirm'));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({ createAddress: { address_formatted: 'Corrientes 500' } }),
    );
    const sentBody = onConfirm.mock.calls[0][0];
    expect(sentBody.createAddress).not.toHaveProperty('address_type');
    expect(sentBody.createAddress).not.toHaveProperty('address_raw');
  });

  it('criar novo COM address_raw → createAddress inclui address_raw trimado, sem address_type', async () => {
    mockListPatientAddresses.mockResolvedValue([]);
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderModal({ item: ITEM_WITH_PATIENT, onConfirm });
    await waitFor(() =>
      expect(screen.getByText('admin.pendingAddressReview.resolveModal.createNew')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('admin.pendingAddressReview.resolveModal.createNew'));
    fireEvent.change(
      screen.getByPlaceholderText('admin.pendingAddressReview.resolveModal.addressFormatted'),
      { target: { value: 'Corrientes 500' } },
    );
    fireEvent.change(
      screen.getByPlaceholderText('admin.pendingAddressReview.resolveModal.addressRaw'),
      { target: { value: '  Corrientes 500 abrev  ' } },
    );

    fireEvent.click(screen.getByText('admin.pendingAddressReview.resolveModal.confirm'));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        createAddress: { address_formatted: 'Corrientes 500', address_raw: 'Corrientes 500 abrev' },
      }),
    );
    const sentBody = onConfirm.mock.calls[0][0];
    expect(sentBody.createAddress).not.toHaveProperty('address_type');
  });
});

// ── select de tipo morto NÃO pode voltar (spec 019, B4) ──────────────────────

describe('ResolveAddressModal — sem select de tipo no modo criar', () => {
  it('no form de criação: nenhum combobox/select, nem os textos das opções antigas (Servicio/Casa/Otro)', async () => {
    mockListPatientAddresses.mockResolvedValue([]);
    const { container } = renderModal({ item: ITEM_WITH_PATIENT });
    await waitFor(() =>
      expect(screen.getByText('admin.pendingAddressReview.resolveModal.createNew')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('admin.pendingAddressReview.resolveModal.createNew'));

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
    expect(screen.queryByText('Servicio')).not.toBeInTheDocument();
    expect(screen.queryByText('Casa')).not.toBeInTheDocument();
    expect(screen.queryByText('Otro')).not.toBeInTheDocument();
  });
});

// ── onClose / isLoading ───────────────────────────────────────────────────────

describe('ResolveAddressModal — onClose e isLoading', () => {
  it('clicar no X chama onClose', () => {
    const onClose = vi.fn();
    renderModal({ item: ITEM_NO_PATIENT, onClose });
    fireEvent.click(screen.getByLabelText('admin.pendingAddressReview.resolveModal.cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicar em Cancelar chama onClose', () => {
    const onClose = vi.fn();
    renderModal({ item: ITEM_NO_PATIENT, onClose });
    fireEvent.click(screen.getByText('admin.pendingAddressReview.resolveModal.cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('isLoading=true desabilita X, Cancelar e Confirmar, e mostra o spinner no Confirmar', async () => {
    mockListPatientAddresses.mockResolvedValue([ADDR_WITH_RAW]);
    const { container } = renderModal({ item: ITEM_WITH_PATIENT, isLoading: true });
    await waitFor(() => expect(screen.getByText('Florida 100, CABA')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Florida 100, CABA').closest('button')!);

    expect(screen.getByLabelText('admin.pendingAddressReview.resolveModal.cancel')).toBeDisabled();
    expect(screen.getByText('admin.pendingAddressReview.resolveModal.cancel').closest('button')).toBeDisabled();
    const confirmBtn = screen.getByText('admin.pendingAddressReview.resolveModal.confirm').closest('button')!;
    expect(confirmBtn).toBeDisabled();
    expect(confirmBtn.querySelector('.animate-spin')).toBeInTheDocument();
    // botão "criar novo" também herda `disabled={isLoading}`
    void container;
  });

  it('isLoading=false: Confirmar sem spinner quando desabilitado só por canConfirm', () => {
    renderModal({ item: ITEM_NO_PATIENT, isLoading: false });
    const confirmBtn = screen.getByText('admin.pendingAddressReview.resolveModal.confirm').closest('button')!;
    expect(confirmBtn.querySelector('.animate-spin')).not.toBeInTheDocument();
  });

  it('isLoading=true desabilita o botão "criar novo"', async () => {
    mockListPatientAddresses.mockResolvedValue([]);
    renderModal({ item: ITEM_WITH_PATIENT, isLoading: true });
    await waitFor(() =>
      expect(screen.getByText('admin.pendingAddressReview.resolveModal.createNew')).toBeInTheDocument(),
    );
    expect(screen.getByText('admin.pendingAddressReview.resolveModal.createNew').closest('button')).toBeDisabled();
  });
});
