import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminTherapeuticProjectsApiService } from '@infrastructure/http/AdminTherapeuticProjectsApiService';
import { TherapeuticCascade } from '@domain/entities/TherapeuticCascade';
import type { TherapeuticCatalogGateway } from '@domain/repositories/TherapeuticCatalogGateway';

/**
 * Adaptador React da cascata do "Nuevo" (091, §9.8): `useState` + delegação à `TherapeuticCascade` (regra pura) +
 * chamada à porta `TherapeuticCatalogGateway`. Chama `POST cascade` quando serviço ou diagnósticos mudam; sem
 * serviço (inclui `services` redigido = `[]`) ou sem diagnóstico, não chama. Trocar serviço zera a seleção.
 * `gateway` é injetável (testes usam um fake da porta); o default é a instância da infraestrutura.
 */
export function useTherapeuticCascade(
  serviceCode: string | null | undefined,
  diagnosisUris: readonly string[],
  gateway: TherapeuticCatalogGateway = AdminTherapeuticProjectsApiService,
) {
  const [cascade, setCascade] = useState<TherapeuticCascade>(() => TherapeuticCascade.empty().chooseService(serviceCode ?? null));
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const code = serviceCode || null;
  const urisKey = JSON.stringify(diagnosisUris);
  const callable = code !== null && diagnosisUris.length > 0;
  const requestKey = callable ? `${code}|${urisKey}` : null;

  useEffect(() => {
    const mine = ++seq.current;
    setCascade((c) => c.chooseService(code));
    setError(null);
    if (!code || diagnosisUris.length === 0) {
      setCascade((c) => c.withoutBlocks());
      return;
    }
    gateway
      .cascade({ serviceCode: code, diagnosisUris: [...diagnosisUris] })
      .then((res) => {
        if (mine !== seq.current) return;
        setCascade((c) => c.withCatalog(res));
        setSettledKey(`${code}|${urisKey}`);
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setSettledKey(`${code}|${urisKey}`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `urisKey` representa `diagnosisUris` por valor
  }, [code, urisKey, gateway]);

  const toggleObjective = useCallback((uri: string, id: string) => setCascade((c) => c.toggleObjective(uri, id)), []);
  const toggleActivity = useCallback((uri: string, id: string) => setCascade((c) => c.toggleActivity(uri, id)), []);

  const isLoading = requestKey !== null && settledKey !== requestKey;
  return {
    cascade,
    blocks: cascade.blocks,
    isLoading,
    error,
    toggleObjective,
    toggleActivity,
    canSubmit: !isLoading && error === null && cascade.canSubmit(),
    toRequestBody: () => cascade.toRequestBody(),
  };
}
