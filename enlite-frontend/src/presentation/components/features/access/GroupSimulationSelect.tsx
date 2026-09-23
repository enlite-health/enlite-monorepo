import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LogOut } from 'lucide-react';
import { Select } from '@presentation/components/atoms';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { AuthzActionError } from '@infrastructure/http/AdminAuthzApiService';

/**
 * F3 (spec 026), decisão #2 do Gabriel: controle de simulação de grupo no
 * rodapé da sidebar — `Select` de grupos vivos (sem o Master) + botão de
 * ícone (logout) ao lado, só quando há simulação ativa.
 *
 * Correção de terreno (L15, 23/09): este projeto é Tailwind + lucide-react +
 * átomos da casa — NÃO MUI. Usa `@presentation/components/atoms/Select`
 * (nativo `<select>`) e um botão cru com `LogOut` do lucide-react, no mesmo
 * padrão do botão de menu já existente em `SidebarUserFooter`. Sem átomo de
 * Tooltip na casa: o "tooltip" do estado desabilitado é o atributo `title`
 * nativo do HTML no wrapper.
 *
 * Deliberadamente sem os wrappers de célula ABAC do módulo de acesso — não é
 * uma célula, é filiação no grupo Master (`canSimulate`), resolvida à parte
 * pelo backend.
 */
export function GroupSimulationSelect(): JSX.Element | null {
  const { t } = useTranslation();
  const authz = useAdminAuthStore((s) => s.authz);
  const startSimulation = useAdminAuthStore((s) => s.startSimulation);
  const endSimulation = useAdminAuthStore((s) => s.endSimulation);
  const listSimulatableGroups = useAdminAuthStore((s) => s.listSimulatableGroups);

  const [grupos, setGrupos] = useState<Array<{ id: string; name: string }>>([]);
  const [erroCode, setErroCode] = useState<string | null>(null);

  const canSimulate = !!authz?.canSimulate;

  useEffect(() => {
    if (!canSimulate) return;
    let ativo = true;
    listSimulatableGroups()
      .then((lista) => {
        if (ativo) setGrupos(lista);
      })
      .catch(() => {
        if (ativo) setGrupos([]);
      });
    return () => {
      ativo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listSimulatableGroups é ação estável do zustand
  }, [canSimulate]);

  if (!authz || !canSimulate) return null;

  const enforcementOn = authz.enforcement === 'on';
  const emSimulacao = !!authz.simulation;

  const handleChange = async (groupId: string): Promise<void> => {
    if (!groupId) return;
    setErroCode(null);
    try {
      await startSimulation(groupId);
    } catch (err) {
      setErroCode(err instanceof AuthzActionError ? err.code : 'unknown');
    }
  };

  const handleExit = async (): Promise<void> => {
    setErroCode(null);
    await endSimulation();
  };

  return (
    <div className="flex items-center gap-1">
      <div
        data-testid="group-simulation-select-disabled-wrapper"
        title={enforcementOn ? undefined : t('access.simulation.disabledEngineOff')}
      >
        <Select
          aria-label={t('access.simulation.select')}
          options={grupos.map((g) => ({ value: g.id, label: g.name }))}
          placeholder={t('access.simulation.select')}
          value=""
          disabled={!enforcementOn}
          inputSize="dense"
          onValueChange={handleChange}
        />
      </div>

      {emSimulacao && (
        <button
          type="button"
          aria-label={t('access.simulation.exit')}
          onClick={handleExit}
          className="hover:opacity-70 transition-opacity shrink-0"
        >
          <LogOut size={14} />
        </button>
      )}

      {erroCode === 'group_not_simulable' && (
        <span className="text-[10px] text-red-600 whitespace-nowrap">
          {t('access.simulation.groupNotSimulable')}
        </span>
      )}
    </div>
  );
}
