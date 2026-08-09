import { useCallback, useEffect, useState } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientChatRoleSpec } from '@domain/value-objects/patientChatRole';

interface UsePatientChatRolesResult {
  roles: PatientChatRoleSpec[];
  /** Código -> quantos pacientes usam. Só vem com `includeInactive`. */
  usage: Record<string, number>;
  isLoading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * usePatientChatRoles — o catálogo de papéis, vindo da API.
 *
 * `includeInactive` separa os dois consumidores: a ficha do paciente quer só os
 * ATIVOS (é o que ela pode gravar) e a tela de administração quer todos MAIS a
 * contagem de uso — o número que a pessoa precisa ver antes de desativar ou
 * apagar um papel.
 *
 * ⚠️ Falha de rede NÃO derruba a ficha do paciente: `roles` fica vazio e o card
 * ainda exibe os papéis que o paciente já tem gravados (ver
 * `chatRolesToDisplay`, que soma os extras). Um catálogo que não carregou não
 * pode fazer um vínculo existente sumir da tela.
 */
export function usePatientChatRoles(includeInactive = false): UsePatientChatRolesResult {
  const [roles, setRoles] = useState<PatientChatRoleSpec[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await AdminApiService.listPatientChatRoles(includeInactive);
      setRoles(data.roles);
      setUsage(data.usage ?? {});
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [includeInactive]);

  useEffect(() => { reload(); }, [reload]);

  return { roles, usage, isLoading, error, reload };
}
