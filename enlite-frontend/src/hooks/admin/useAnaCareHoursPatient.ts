import { useState, useEffect, useCallback, useRef } from 'react';
import { AnaCareHoursServiceError, type AnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';
import { mergePatientMonths, parseMonthParam } from '@presentation/components/features/admin/AnaCareHours/selectors';
import type { AnaCareHoursPatientSnapshot, AnaCarePatient, AnaCareRetratoStatus } from '@presentation/components/features/admin/AnaCareHours/types';

/** Estado da busca de UM mês do paciente — `error` nunca é lido como "sem turnos". */
export interface MonthStatus {
  state: 'loading' | 'ok' | 'error';
  error: string | null;
}

interface Entry<T> {
  state: MonthStatus['state'];
  value: T | null;
  error: string | null;
}

function describeError(err: unknown): string {
  if (err instanceof AnaCareHoursServiceError && err.code === 'FONTE_NAO_CONFIGURADA') return 'FONTE_NAO_CONFIGURADA';
  return err instanceof Error ? err.message : 'No se pudo cargar el paciente.';
}

/** Só `YYYY-MM` entre o piso e o mês corrente chega ao backend (a validação do `?month` é a mesma). */
function isFetchableMonth(month: string): boolean {
  return parseMonthParam(month) === month;
}

/**
 * Detalhe do paciente "como paginação" (spec 037): busca SÓ os meses pedidos em `months` que ainda
 * não estão no cache da visita (`Map` por mês, vive enquanto o hook vive; trocar de paciente zera).
 * A falha de um mês não derruba nem apaga os outros — vira `monthStates[mês].state === 'error'`,
 * nunca um mês vazio. O retrato (`getRetratoStatus`, snapshot completo do mês) só é pedido para o mês
 * da URL (`retratoMonth`). `refetch` refaz todos os meses carregados; `retryMonth` refaz um só.
 * Monta um `AnaCareHoursPatientSnapshot` "de 1 paciente só" com os meses unidos (`mergePatientMonths`).
 */
export function useAnaCareHoursPatient(service: AnaCareHoursService, patientId: string, months: string[], retratoMonth: string) {
  const [entries, setEntries] = useState<Record<string, Entry<AnaCarePatient | null>>>({});
  const [retratos, setRetratos] = useState<Record<string, Entry<AnaCareRetratoStatus>>>({});
  const [pending, setPending] = useState(0);
  const generation = useRef(0);
  const requested = useRef<Set<string>>(new Set());

  const loadPatient = useCallback(
    async (month: string): Promise<void> => {
      const gen = generation.current;
      requested.current.add(`p:${month}`);
      setEntries((prev) => (prev[month]?.state === 'ok' ? prev : { ...prev, [month]: { state: 'loading', value: prev[month]?.value ?? null, error: null } }));
      setPending((n) => n + 1);
      try {
        const patient = await service.getPatientMonth(month, patientId);
        if (gen === generation.current) setEntries((prev) => ({ ...prev, [month]: { state: 'ok', value: patient, error: null } }));
      } catch (err: unknown) {
        if (gen === generation.current) setEntries((prev) => ({ ...prev, [month]: { state: 'error', value: prev[month]?.value ?? null, error: describeError(err) } }));
      } finally {
        if (gen === generation.current) setPending((n) => n - 1);
      }
    },
    [service, patientId],
  );

  const loadRetrato = useCallback(
    async (month: string): Promise<void> => {
      const gen = generation.current;
      requested.current.add(`r:${month}`);
      setRetratos((prev) => (prev[month]?.state === 'ok' ? prev : { ...prev, [month]: { state: 'loading', value: prev[month]?.value ?? null, error: null } }));
      setPending((n) => n + 1);
      try {
        const retrato = await service.getRetratoStatus(month);
        if (gen === generation.current) setRetratos((prev) => ({ ...prev, [month]: { state: 'ok', value: retrato, error: null } }));
      } catch (err: unknown) {
        if (gen === generation.current) setRetratos((prev) => ({ ...prev, [month]: { state: 'error', value: prev[month]?.value ?? null, error: describeError(err) } }));
      } finally {
        if (gen === generation.current) setPending((n) => n - 1);
      }
    },
    [service],
  );

  // Trocar de paciente (ou de serviço) zera o cache da visita; respostas em voo da visita anterior são descartadas.
  useEffect(() => {
    generation.current += 1;
    requested.current = new Set();
    setEntries({});
    setRetratos({});
    setPending(0);
  }, [service, patientId]);

  const monthsKey = months.filter(isFetchableMonth).join(',');
  useEffect(() => {
    for (const month of monthsKey.split(',').filter(Boolean)) {
      if (!requested.current.has(`p:${month}`)) void loadPatient(month);
    }
    if (isFetchableMonth(retratoMonth) && !requested.current.has(`r:${retratoMonth}`)) void loadRetrato(retratoMonth);
  }, [loadPatient, loadRetrato, monthsKey, retratoMonth]);

  /** "Actualizar" e as ações de escrita: refaz TODOS os meses atualmente carregados, não só o da URL. */
  const refetch = useCallback(() => {
    for (const key of Array.from(requested.current)) {
      const month = key.slice(2);
      if (key.startsWith('p:')) void loadPatient(month);
      else void loadRetrato(month);
    }
  }, [loadPatient, loadRetrato]);

  /** "Reintentar" de um mês que falhou — refaz só esse mês (e o retrato, se foi ele quem falhou). */
  const retryMonth = useCallback(
    (month: string) => {
      void loadPatient(month);
      if (retratos[month]?.state === 'error') void loadRetrato(month);
    },
    [loadPatient, loadRetrato, retratos],
  );

  const monthStates: Record<string, MonthStatus> = {};
  for (const month of monthsKey.split(',').filter(Boolean)) {
    const entry = entries[month];
    // `monthStates` fala só de TURNOS: a falha do retrato não se passa por falha de turnos (vai em `error`, abaixo).
    if (entry?.state === 'error') monthStates[month] = { state: 'error', error: entry.error };
    else monthStates[month] = { state: entry?.state ?? 'loading', error: null };
  }

  const loadedMonths = Object.keys(entries).sort();
  const patient = mergePatientMonths(loadedMonths.map((m) => entries[m].value));
  // O retrato exibido é SEMPRE o do mês da URL; enquanto não chegou, é "carregando" (nunca o retrato de outro mês).
  const retrato = retratos[retratoMonth]?.value ?? null;

  const snapshot: AnaCareHoursPatientSnapshot | null = retrato
    ? {
        month: retratoMonth,
        updatedAt: retrato.updatedAt,
        stale: retrato.stale,
        // Item 3 (conserto, 17/09): `AnaCareRetratoStatus` agora carrega `snapshotState` — não
        // aproxima mais. Antes disso, `stale ? 'velho' : 'fresco'` colapsava "nunca construído" em
        // "velho" e o detalhe mostrava "mais de 24 horas" quando o sync nunca rodou.
        snapshotState: retrato.snapshotState,
        circuitBreakerOpen: retrato.circuitBreakerOpen,
        patients: patient ? [patient] : [],
        // F2 (migration 457) — mesmo repasse de `snapshotState`: só existem quando `parcial`.
        reservationsTotal: retrato.reservationsTotal,
        reservationsDone: retrato.reservationsDone,
      }
    : null;

  // Retrato do mês da URL ainda em voo, mas já há turnos `ok` na tela: a página NÃO pode desmontar (a data
  // selecionada e os dias carregados ficam). Só o retrato é "desconhecido" — placeholder sem dado de outro mês;
  // `snapshot` (acima) continua `null` até o retrato verdadeiro chegar.
  const retratoLoading = retrato === null && (retratos[retratoMonth] === undefined || retratos[retratoMonth].state === 'loading');
  const provisionalSnapshot: AnaCareHoursPatientSnapshot | null =
    retratoLoading && loadedMonths.some((m) => entries[m].state === 'ok')
      ? { month: retratoMonth, updatedAt: '', stale: false, snapshotState: 'desconhecido', circuitBreakerOpen: false, patients: patient ? [patient] : [] }
      : null;

  // Erro de TELA INTEIRA só na 1ª carga (nada para mostrar ainda). Depois disso, a falha de um mês é
  // inline (`monthStates`) — os dias dos outros meses nunca somem em silêncio.
  const hasData = snapshot !== null && loadedMonths.some((m) => entries[m].state === 'ok');
  const firstLoadError = entries[retratoMonth]?.state === 'error' ? entries[retratoMonth].error : retratos[retratoMonth]?.state === 'error' ? retratos[retratoMonth].error : null;
  // Com dados na tela, só a falha do RETRATO do mês da URL sobe como `error` (texto próprio, como na stage); a de turnos é inline.
  const retratoError = retratos[retratoMonth]?.state === 'error' ? retratos[retratoMonth].error : null;
  const error = hasData ? retratoError : firstLoadError;
  // 1ª carga ainda não assentou (o mês da URL e o retrato dele ainda não responderam) — evita um quadro "vazio" antes da busca começar.
  const firstLoadSettled = [entries[retratoMonth], retratos[retratoMonth]].every((e) => e !== undefined && e.state !== 'loading');
  const isLoading = pending > 0 || !firstLoadSettled;

  return { patient, snapshot, provisionalSnapshot, isLoading, error, refetch, retryMonth, monthStates };
}
