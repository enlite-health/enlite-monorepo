/**
 * ContadorAceitos — os dois contadores de "aceita sem contestar" do Sol (D601), só leitura.
 * Contador 1: propostas vindas de outras pessoas artificiais (régua de 1 mês). Contador 2: propostas do próprio Sol (6 meses).
 * Estilo e tintas AAA (>= 7:1) copiados do PedidoPost (borda #595959, texto #1A1A1A/#404040). Sem percentual: com 0 pedidos
 * mostra "0" e o estado vazio. Falha ao carregar é um aviso discreto (role=status) — nunca derruba a página.
 * A montagem na PedidosIaPage é da T098.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AdminPedidosIaApiService,
  type ContadorAceitosDados,
  type ContadoresAceitos,
} from '@infrastructure/http/AdminPedidosIaApiService';

interface Props {
  de?: string;
  ate?: string;
}

function Contador({ n, dados }: { n: 1 | 2; dados: ContadorAceitosDados }): JSX.Element {
  const { t } = useTranslation();
  const base = `admin.pedidosIa.contadores.c${n}`;
  const vazio = dados.pedidos === 0;
  const badge = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold';

  return (
    <section
      data-testid={`contador-${n}`}
      data-atingiu={dados.atingiuRegua ? 'true' : 'false'}
      className="rounded-[20px] border-2 border-[#595959] bg-white p-4 sm:p-5"
    >
      <h3 className="break-words text-base font-semibold text-[#1A1A1A]">{t(`${base}.title`)}</h3>
      <p className="mt-1 text-sm text-[#404040]">{t(`${base}.regra`)}</p>

      {vazio ? (
        <>
          <p data-testid={`contador-${n}-semanas`} className="mt-3 text-3xl font-semibold text-[#1A1A1A]">
            {0}
          </p>
          <p data-testid={`contador-${n}-vazio`} className="mt-1 text-sm text-[#404040]">
            {t('admin.pedidosIa.contadores.vazio')}
          </p>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm font-semibold text-[#1A1A1A]">
            <span data-testid={`contador-${n}-semanas`} className="text-3xl">
              {dados.semanasValidasSeguidas}
            </span>{' '}
            <span data-testid={`contador-${n}-regua`}>
              {t('admin.pedidosIa.contadores.semanas', { atual: dados.semanasValidasSeguidas, regua: dados.reguaSemanas })}
            </span>
          </p>
          <p className="mt-2">
            <span
              data-testid={`contador-${n}-atingiu`}
              className={`${badge} ${dados.atingiuRegua ? 'bg-[#E3F4E8] text-[#0F3D20]' : 'bg-[#F5ECD6] text-[#4A3300]'}`}
            >
              {dados.atingiuRegua ? t('admin.pedidosIa.contadores.atingiu') : t('admin.pedidosIa.contadores.naoAtingiu')}
            </span>
          </p>
          <p data-testid={`contador-${n}-ultima-contestacao`} className="mt-2 text-sm text-[#404040]">
            {dados.ultimaContestacaoSemana
              ? t('admin.pedidosIa.contadores.ultimaContestacao', { semana: dados.ultimaContestacaoSemana })
              : t('admin.pedidosIa.contadores.semContestacao')}
          </p>
          <p data-testid={`contador-${n}-pedidos`} className="mt-1 text-sm text-[#404040]">
            {t('admin.pedidosIa.contadores.pedidos', { count: dados.pedidos })}
          </p>
          <p data-testid={`contador-${n}-pendentes`} className="mt-1 text-sm text-[#404040]">
            {t('admin.pedidosIa.contadores.pendentes', { count: dados.pendentes })}
          </p>
        </>
      )}
    </section>
  );
}

export function ContadorAceitos({ de, ate }: Props): JSX.Element {
  const { t } = useTranslation();
  const [estado, setEstado] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dados, setDados] = useState<ContadoresAceitos | null>(null);

  useEffect(() => {
    let vivo = true;
    setEstado('loading');
    AdminPedidosIaApiService.getContadores({ de, ate })
      .then((r) => {
        if (!vivo) return;
        setDados(r);
        setEstado('ready');
      })
      .catch((err: unknown) => {
        // Erro não é engolido mudo (D587): fica no console com nome e código; a página segue.
        console.error('ContadorAceitos.getContadores falhou', (err as { code?: string; status?: number })?.code ?? (err as { status?: number })?.status);
        if (vivo) setEstado('error');
      });
    return () => {
      vivo = false;
    };
  }, [de, ate]);

  return (
    <div data-testid="contador-aceitos" aria-label={t('admin.pedidosIa.contadores.title')} className="space-y-3">
      <h2 className="text-lg font-semibold text-[#1A1A1A]">{t('admin.pedidosIa.contadores.title')}</h2>
      {estado === 'loading' && (
        <p data-testid="contador-aceitos-loading" className="text-sm text-[#404040]">
          {t('admin.pedidosIa.contadores.loading')}
        </p>
      )}
      {estado === 'error' && (
        <p data-testid="contador-aceitos-erro" role="status" className="text-sm text-[#404040]">
          {t('admin.pedidosIa.contadores.error')}
        </p>
      )}
      {estado === 'ready' && dados && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Contador n={1} dados={dados.contador1} />
          <Contador n={2} dados={dados.contador2} />
        </div>
      )}
    </div>
  );
}
