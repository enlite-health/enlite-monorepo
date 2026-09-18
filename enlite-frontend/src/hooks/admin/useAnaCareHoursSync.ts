import { useCallback, useEffect, useRef, useState } from 'react';
import { AnaCareHoursServiceError, type AnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';

/**
 * Orçamento de tempo por RODADA do sync manual (F6.4, botão "Sincronizar" da lista) — medido na
 * stage em 18/09: uma rodada de 100s cobriu 74 das 283 reservas do mês (~4 rodadas, ~7 min no
 * total, ver `bin/anacare-medicoes/stg-anacare-sync.mjs`). O laço de várias rodadas é DESTE hook —
 * cada `service.triggerSync` é UMA chamada de rede, nunca o sync inteiro.
 */
const SYNC_ROUND_BUDGET_MS = 100_000;

function storageKey(month: string): string {
  return `anacare-hours-sync:${month}`;
}

/** `sessionStorage` pode faltar (modo privado, quota, ambiente de teste sem DOM completo) — nesse caso a retomada por refresh simplesmente não funciona; a corrida em si não depende disto. */
function readResumableCursor(month: string): number | null {
  try {
    const raw = sessionStorage.getItem(storageKey(month));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { cursor?: unknown };
    return typeof parsed.cursor === 'number' ? parsed.cursor : null;
  } catch {
    return null;
  }
}

function persistCursor(month: string, cursor: number): void {
  try {
    sessionStorage.setItem(storageKey(month), JSON.stringify({ cursor }));
  } catch {
    // ver readResumableCursor — best effort, nunca derruba a corrida.
  }
}

function clearCursor(month: string): void {
  try {
    sessionStorage.removeItem(storageKey(month));
  } catch {
    // idem.
  }
}

export type AnaCareHoursSyncStatus = 'idle' | 'running' | 'done' | 'error' | 'deduped';

/** Token por CORRIDA — o `loop` de uma corrida só olha para O SEU objeto, nunca `ref.current` (ver `runTokenRef`). */
interface RunToken {
  cancelled: boolean;
}

export interface UseAnaCareHoursSyncResult {
  status: AnaCareHoursSyncStatus;
  /** Rodada atual (1-based) — só tem sentido enquanto `status === 'running'`. */
  round: number;
  /** Soma de `reservationsProcessed` de todas as rodadas já concluídas nesta corrida. */
  reservationsProcessed: number;
  error: string | null;
  /** Cursor de uma corrida anterior interrompida (refresh no meio) — presente só quando `status !== 'running'`. */
  resumableCursor: number | null;
  /** Dispara a corrida — retoma de `resumableCursor` quando ele existe, senão começa do zero. */
  start: () => void;
}

/**
 * Laço de cursor do botão "Sincronizar" da lista (F6.4/tasks 4.8-4.9) — CADA rodada é uma chamada
 * de `service.triggerSync`; o laço em si (repetir até `nextCursor === null`) é do CLIENTE. Persiste
 * o cursor em `sessionStorage` a cada rodada BEM-SUCEDIDA (nunca o de uma rodada que falhou) — um
 * refresh no meio da corrida encontra `resumableCursor` preenchido e a tela oferece retomar dali.
 * Erro no meio PARA o laço, preserva o último cursor persistido e NUNCA marca `status: 'done'`.
 */
export function useAnaCareHoursSync(service: AnaCareHoursService, month: string, onComplete?: () => void): UseAnaCareHoursSyncResult {
  const [status, setStatus] = useState<AnaCareHoursSyncStatus>('idle');
  const [round, setRound] = useState(0);
  const [reservationsProcessed, setReservationsProcessed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [resumableCursor, setResumableCursor] = useState<number | null>(() => readResumableCursor(month));
  /**
   * Token da corrida ATUAL — cada `start()` cria um objeto NOVO e o `loop` daquela corrida captura
   * esse objeto no início, olhando só para ELE (nunca para `runTokenRef.current`). Por quê: um
   * boolean compartilhado no ref (`cancelledRef.current = false`) fica sujeito a corrida — trocar de
   * mês no MEIO de uma corrida em voo faz o cleanup marcar cancelado e o efeito novo, no MESMO
   * render, marcar `false` de novo; o laço antigo (que só olhava `ref.current`) lia esse `false` e
   * seguia rodando, terminando com `status: 'done'` do mês NOVO sem ter sincronizado nada dele.
   * Com token por objeto, o cleanup marca `cancelled=true` NO OBJETO DAQUELE `start()` — o objeto
   * novo do mês seguinte é outra referência, e o laço antigo, que capturou a referência velha,
   * fica cancelado para sempre.
   */
  const runTokenRef = useRef<RunToken>({ cancelled: true });
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Trocar de mês cancela qualquer corrida em curso do mês anterior (mesmo padrão de
  // `useAnaCareHoursMonth`: o cleanup do efeito roda a cada troca de dependência, não só no unmount)
  // e relê o cursor retomável do mês novo.
  useEffect(() => {
    setStatus('idle');
    setError(null);
    setRound(0);
    setReservationsProcessed(0);
    setResumableCursor(readResumableCursor(month));
    return () => {
      // Lê `runTokenRef.current` NO MOMENTO do cleanup (não um valor capturado na criação do
      // efeito) — entre o efeito rodar e o cleanup disparar, `start()` pode ter trocado o token
      // para o objeto da corrida em voo, e é ESSE objeto que precisa ser cancelado.
      runTokenRef.current.cancelled = true;
    };
  }, [month]);

  const start = useCallback(() => {
    if (!service.triggerSync) return;
    const trigger: NonNullable<AnaCareHoursService['triggerSync']> = service.triggerSync;

    setStatus('running');
    setError(null);
    setRound(0);
    setReservationsProcessed(0);

    let cursor: number | undefined = resumableCursor ?? undefined;

    // Token desta corrida — ver comentário de `runTokenRef` acima. O `loop` só consulta ESTE
    // objeto (`token`), nunca `runTokenRef.current` (que pode já apontar para outra corrida).
    const token: RunToken = { cancelled: false };
    runTokenRef.current = token;

    async function loop(): Promise<void> {
      let roundsRun = 0;
      let processedTotal = 0;
      for (;;) {
        roundsRun += 1;
        let result;
        try {
          result = await trigger({ month, cursor, budgetMs: SYNC_ROUND_BUDGET_MS });
        } catch (err) {
          if (token.cancelled) return;
          const message = err instanceof AnaCareHoursServiceError || err instanceof Error ? err.message : 'No se pudo sincronizar.';
          setStatus('error');
          setError(message);
          return;
        }
        if (token.cancelled) return;

        // (B) Servidor deduplicou (outra corrida já em curso) — PARA imediatamente: não avança
        // cursor, não chama onComplete, não limpa o cursor persistido (D decidida, não redesenhar).
        if (result.deduped) {
          setStatus('deduped');
          return;
        }

        processedTotal += result.reservationsProcessed;
        setRound(roundsRun);
        setReservationsProcessed(processedTotal);

        if (result.nextCursor === null) {
          clearCursor(month);
          setResumableCursor(null);
          setStatus('done');
          onCompleteRef.current?.();
          return;
        }

        cursor = result.nextCursor;
        persistCursor(month, cursor);
        setResumableCursor(cursor);
      }
    }

    void loop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, month, resumableCursor]);

  return { status, round, reservationsProcessed, error, resumableCursor, start };
}
