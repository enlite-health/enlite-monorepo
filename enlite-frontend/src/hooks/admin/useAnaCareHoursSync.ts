import { useCallback, useEffect, useRef, useState } from 'react';
import { AnaCareHoursServiceError, type AnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';

/**
 * Orçamento de tempo por RODADA do sync manual (F6.4, botão "Sincronizar" da lista) — medido na
 * stage em 18/09: uma rodada de 100s cobriu 74 das 283 reservas do mês (~4 rodadas, ~7 min no
 * total, ver `bin/anacare-medicoes/stg-anacare-sync.mjs`). O laço de várias rodadas é DESTE hook —
 * cada `service.triggerSync` é UMA chamada de rede, nunca o sync inteiro.
 *
 * 30s (não 100s): o Firebase Hosting na frente de `api.enlite.health` (prd) CORTA requisições
 * repassadas ao Cloud Run em 60s — medido em 21/09, POST /sync real levava 103-116s de rodada
 * (overhead de até ~16s sobre o budget), o navegador via "blocked by CORS"/ERR_FAILED aos ~60s
 * sem nunca receber `nextCursor`, e a corrida ficava "running" pra sempre. Rodada real = budget +
 * overhead (~16s) — 30s de budget fica em ~46s, abaixo do corte.
 */
const SYNC_ROUND_BUDGET_MS = 30_000;

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
  /**
   * Mês de uma corrida cancelada por TROCA DE MÊS com uma rodada em voo — a rodada em voo não
   * pode ser abortada de verdade (a chamada de rede já saiu), então quando ela resolve com sucesso
   * o cursor É persistido (retomável) mesmo cancelada, e este campo guarda de QUAL mês, para a tela
   * avisar em vez de ficar em silêncio. `null` quando não há interrupção pendente para relatar.
   * Fica de pé até `start()` rodar de novo ou até o usuário voltar para este mês (nesse ponto
   * `resumableCursor`/`resumeHint` do próprio mês já cobrem o aviso).
   */
  interruptedMonth: string | null;
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
  const [interruptedMonth, setInterruptedMonth] = useState<string | null>(null);
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
  /** Mês ATUAL do hook, sempre em dia — ao contrário de `runMonth` (capturado no `start()` e fixo
   * pela vida da corrida), este ref reflete renders futuros. Necessário para o ramo cancelado
   * (abaixo) distinguir "usuário está em outro mês" de "usuário já voltou para este mesmo mês
   * antes da rodada em voo resolver". */
  const monthRef = useRef(month);
  monthRef.current = month;

  // Trocar de mês cancela qualquer corrida em curso do mês anterior (mesmo padrão de
  // `useAnaCareHoursMonth`: o cleanup do efeito roda a cada troca de dependência, não só no unmount)
  // e relê o cursor retomável do mês novo.
  useEffect(() => {
    setStatus('idle');
    setError(null);
    setRound(0);
    setReservationsProcessed(0);
    setResumableCursor(readResumableCursor(month));
    // Voltar para o mês que ficou com uma interrupção pendente: o `resumeHint` deste mesmo mês
    // (linha acima, via `resumableCursor`) já avisa que há corrida retomável — não duplicar aviso.
    setInterruptedMonth((prev) => (prev === month ? null : prev));
    return () => {
      // Lê `runTokenRef.current` NO MOMENTO do cleanup (não um valor capturado na criação do
      // efeito) — entre o efeito rodar e o cleanup disparar, `start()` pode ter trocado o token
      // para o objeto da corrida em voo, e é ESSE objeto que precisa ser cancelado.
      runTokenRef.current.cancelled = true;
    };
  }, [month]);

  const start = useCallback(() => {
    if (!service.triggerSync) return;
    const trigger: NonNullable<AnaCareHoursService['triggerSync']> = service.triggerSync.bind(service);

    setStatus('running');
    setError(null);
    setRound(0);
    setReservationsProcessed(0);
    // Esta corrida (deste mês ou de outro) supera qualquer interrupção que ainda estivesse
    // esperando aviso — evita duas mensagens conflitantes na tela ao mesmo tempo.
    setInterruptedMonth(null);

    let cursor: number | undefined = resumableCursor ?? undefined;
    // Capturado AGORA (não lido de `month` dentro do `loop`, que é um parâmetro do hook e pode
    // mudar de valor lógico ao longo da vida deste `useCallback` — na prática já é fixo por
    // `useCallback` dep, mas nomear deixa explícito que é o mês DESTA corrida, usado inclusive
    // depois de cancelada para persistir o cursor certo).
    const runMonth = month;

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
          result = await trigger({ month: runMonth, cursor, budgetMs: SYNC_ROUND_BUDGET_MS });
        } catch (err) {
          if (token.cancelled) return;
          const message = err instanceof AnaCareHoursServiceError || err instanceof Error ? err.message : 'No se pudo sincronizar.';
          setStatus('error');
          setError(message);
          return;
        }
        if (token.cancelled) {
          // A chamada de rede já tinha saído antes da troca de mês — não dá para "desfazer" a
          // rodada, então o resultado é honrado no ARMAZENAMENTO (retomável), mesmo sem tocar no
          // estado de tela deste hook (que já pertence ao mês NOVO). Nunca `onComplete` aqui: o
          // dono do refetch é o mês atual, não o cancelado.
          if (!result.deduped) {
            // O usuário pode já ter voltado para ESTE mês antes desta rodada resolver — nesse
            // caso o efeito de troca de mês (linha ~110) releu `resumableCursor` do storage ANTES
            // deste persist, e ficou com um valor desatualizado (ou `null`). Reidrata agora a
            // partir do que acabou de ser persistido, em vez de deixar o próximo `start()` sair
            // sem cursor e recomeçar do zero. Só há "outro mês" para avisar via `interruptedMonth`
            // quando o usuário NÃO está de volta a este mês (ver comentário de `interruptedMonth`
            // na interface, linhas ~61-66).
            const backOnThisMonth = runMonth === monthRef.current;
            if (result.nextCursor !== null) {
              persistCursor(runMonth, result.nextCursor);
              if (backOnThisMonth) {
                setResumableCursor(result.nextCursor);
              } else {
                setInterruptedMonth(runMonth);
              }
            } else {
              clearCursor(runMonth);
              if (backOnThisMonth) {
                setResumableCursor(null);
              }
            }
          }
          return;
        }

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
          clearCursor(runMonth);
          setResumableCursor(null);
          setStatus('done');
          onCompleteRef.current?.();
          return;
        }

        cursor = result.nextCursor;
        persistCursor(runMonth, cursor);
        setResumableCursor(cursor);
      }
    }

    void loop();
  }, [service, month, resumableCursor]);

  return { status, round, reservationsProcessed, error, resumableCursor, interruptedMonth, start };
}
