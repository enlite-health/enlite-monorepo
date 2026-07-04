import { create } from 'zustand';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { InviteTarget } from '@presentation/components/features/admin/VacancyMatch/inviteTypes';

/** Intervalo entre envios — respeita o rate limit do Twilio. */
const SEND_INTERVAL_MS = 300;
/** Tempo até o painel se auto-descartar quando concluiu sem erros. */
const AUTO_DISMISS_MS = 5000;

export type SendItemStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'error'
  | 'cancelled';

export interface SendItem {
  vacancyId: string;
  workerId: string;
  workerName: string;
  status: SendItemStatus;
  error?: string;
}

export type MessagedCallback = (workerId: string, messagedAt: string) => void;

interface InviteProgressState {
  items: SendItem[];
  /** Loop de envio em andamento. */
  isSending: boolean;
  /** Painel flutuante visível. */
  isOpen: boolean;
  /** Painel recolhido (só header) vs expandido (lista). */
  collapsed: boolean;
  /** Pedido de cancelamento — o loop marca os pendentes como `cancelled`. */
  cancelRequested: boolean;

  /**
   * Enfileira um lote de convites para envio em background. Pode ser chamado
   * com um envio já em andamento — os novos itens são anexados à fila
   * (deduplicados por workerId ainda não-terminal) e o mesmo loop os processa,
   * mantendo o espaçamento global de {@link SEND_INTERVAL_MS}.
   */
  enqueue: (
    vacancyId: string,
    candidates: InviteTarget[],
    onMessaged?: MessagedCallback,
  ) => void;
  /** Cancela os envios ainda pendentes (os já enviados não voltam atrás). */
  cancel: () => void;
  /** Fecha o painel e zera o estado. */
  dismiss: () => void;
  toggleCollapsed: () => void;
}

// ── Estado fora do React ──────────────────────────────────────────────────────
// Callbacks e timers ficam em module scope pra não disparar re-render do painel
// e pra sobreviverem à troca de tela (o store é global, montado uma vez no App).

const messagedCallbacks = new Map<string, MessagedCallback>();
let autoDismissTimer: ReturnType<typeof setTimeout> | null = null;
/** Trava de reentrância — garante um único loop de envio por vez. */
let pumping = false;

function clearAutoDismiss(): void {
  if (autoDismissTimer !== null) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const useInviteProgressStore = create<InviteProgressState>((set, get) => {
  /** Aplica status a um item específico. */
  function patchItem(workerId: string, patch: Partial<SendItem>): void {
    set((s) => ({
      items: s.items.map((it) =>
        it.workerId === workerId ? { ...it, ...patch } : it,
      ),
    }));
  }

  /** Envia um item e reflete o resultado no estado. */
  async function sendOne(item: SendItem): Promise<void> {
    patchItem(item.workerId, { status: 'sending' });
    try {
      await AdminApiService.sendVacancyMatchInvite(item.workerId, item.vacancyId);
      const messagedAt = new Date().toISOString();
      messagedCallbacks.get(item.vacancyId)?.(item.workerId, messagedAt);
      patchItem(item.workerId, { status: 'sent' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Falha no envio';
      patchItem(item.workerId, { status: 'error', error: message });
    }
  }

  /** Encerra o loop; agenda auto-descarte só se concluiu limpo. */
  function finish(): void {
    const { items, cancelRequested } = get();
    const hasError = items.some((it) => it.status === 'error');
    const hasCancelled = items.some((it) => it.status === 'cancelled');
    set({ isSending: false });

    // Só some sozinho quando tudo deu certo — erro/cancelado fica pra revisão.
    if (!hasError && !hasCancelled && !cancelRequested) {
      clearAutoDismiss();
      autoDismissTimer = setTimeout(() => get().dismiss(), AUTO_DISMISS_MS);
    }
  }

  /**
   * Loop principal: processa o próximo pendente até esvaziar a fila. A trava
   * `pumping` impede que um `enqueue` concorrente (durante o intervalo entre
   * envios, quando nenhum item está `sending`) dispare um segundo loop paralelo
   * — o que quebraria o espaçamento e duplicaria envios.
   */
  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (get().cancelRequested) {
          set((s) => ({
            items: s.items.map((it) =>
              it.status === 'pending'
                ? { ...it, status: 'cancelled' as const }
                : it,
            ),
          }));
          break;
        }

        const next = get().items.find((it) => it.status === 'pending');
        if (!next) break;

        await sendOne(next);

        const hasMore =
          !get().cancelRequested &&
          get().items.some((it) => it.status === 'pending');
        if (hasMore) await delay(SEND_INTERVAL_MS);
      }
    } finally {
      pumping = false;
      finish();
    }
  }

  return {
    items: [],
    isSending: false,
    isOpen: false,
    collapsed: false,
    cancelRequested: false,

    enqueue: (vacancyId, candidates, onMessaged) => {
      clearAutoDismiss();
      if (onMessaged) messagedCallbacks.set(vacancyId, onMessaged);

      set((s) => {
        // Dedupe: ignora workers já na fila em estado não-terminal.
        const active = new Set(
          s.items
            .filter((it) => it.status === 'pending' || it.status === 'sending')
            .map((it) => it.workerId),
        );
        const fresh: SendItem[] = candidates
          .filter((c) => !active.has(c.workerId))
          .map((c) => ({
            vacancyId,
            workerId: c.workerId,
            workerName: c.workerName,
            status: 'pending' as const,
          }));

        return {
          items: [...s.items, ...fresh],
          isOpen: true,
          collapsed: false,
          cancelRequested: false,
          isSending: true,
        };
      });

      // Um único loop por vez (trava `pumping`); se já rodava, ele pega os
      // novos itens na próxima iteração.
      void pump();
    },

    cancel: () => {
      set({ cancelRequested: true });
    },

    dismiss: () => {
      clearAutoDismiss();
      messagedCallbacks.clear();
      set({
        items: [],
        isSending: false,
        isOpen: false,
        collapsed: false,
        cancelRequested: false,
      });
    },

    toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
  };
});
