/**
 * PedidosIaPage — `/admin/pedidos-ia` (spec 078, M3b-1.4): os pedidos do Sol como posts, com 3 botões
 * (Aceitar / Negar / Descrever o que fazer). Abre com `pedidos_ia:read`; os botões só existem com `pedidos_ia:decidir`
 * (mesma régua D268/D269 do `ActionButton`: com o engine OFF a célula não barra, e a API responde 403 → mensagem traduzida).
 * Contrato carregando = diz que carrega; em erro = diz que falhou (fail-closed). Lista, filtros por área e status,
 * ordenação por idade. Ver NÃO grava nada; cada decisão grava 1 evento no backend.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useActionGate, useCellAccess, useContainerAccess } from '@presentation/hooks/useCellAccess';
import {
  AdminPedidosIaApiService,
  type Pedido,
  type PedidoStatus,
} from '@infrastructure/http/AdminPedidosIaApiService';
import { PedidoPost } from './PedidoPost';
import { DecisaoModal, type DecisaoModo } from './DecisaoModal';
import { pedidosIaErrorKey } from './pedidosIaErrors';

const STATUS: readonly PedidoStatus[] = ['novo', 'aceito', 'negado', 'redirecionado'];
type Ordem = 'novos' | 'antigos';

export function PedidosIaPage(): JSX.Element {
  const { t } = useTranslation();
  const access = useCellAccess('pedidos_ia');
  const { visible } = useContainerAccess('pedidos_ia');
  const { allowed: podeDecidir } = useActionGate('pedidos_ia', 'decidir');

  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [carga, setCarga] = useState<'loading' | 'ready' | 'error'>('loading');
  const [area, setArea] = useState('');
  const [status, setStatus] = useState<PedidoStatus | ''>('');
  const [ordem, setOrdem] = useState<Ordem>('novos');
  const [areas, setAreas] = useState<string[]>([]);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<{ id: string; modo: DecisaoModo } | null>(null);
  const [modalErro, setModalErro] = useState<string | null>(null);

  const pronto = access.status === 'ready' && visible;

  useEffect(() => {
    if (!pronto) return;
    let vivo = true;
    setCarga('loading');
    AdminPedidosIaApiService.list({ area: area || undefined, status: status || undefined })
      .then((lista) => {
        if (!vivo) return;
        setPedidos(lista);
        // As opções do filtro de área vêm do que já foi visto: filtrar por uma área não pode apagar as outras.
        setAreas((prev) => [...new Set([...prev, ...lista.map((p) => p.area)])].sort());
        setCarga('ready');
      })
      .catch(() => vivo && setCarga('error'));
    return () => {
      vivo = false;
    };
  }, [pronto, area, status]);

  const ordenados = useMemo(
    () => [...pedidos].sort((a, b) => (ordem === 'novos' ? a.idade_h - b.idade_h : b.idade_h - a.idade_h)),
    [pedidos, ordem],
  );

  const aplicar = useCallback((atualizado: Pedido) => {
    setPedidos((prev) => prev.map((p) => (p.id === atualizado.id ? atualizado : p)));
  }, []);

  const decidir = useCallback(
    async (id: string, acao: () => Promise<unknown>, noErro: (key: string) => void): Promise<boolean> => {
      setOcupado(id);
      try {
        await acao();
        aplicar(await AdminPedidosIaApiService.get(id)); // o evento novo aparece no histórico
        setErros((e) => ({ ...e, [id]: '' }));
        return true;
      } catch (err) {
        noErro(pedidosIaErrorKey(err));
        return false;
      } finally {
        setOcupado(null);
      }
    },
    [aplicar],
  );

  const aceitar = (id: string) =>
    decidir(id, () => AdminPedidosIaApiService.aceitar(id), (key) => setErros((e) => ({ ...e, [id]: key })));

  const confirmarModal = async (texto: string) => {
    if (!modal) return;
    const { id, modo } = modal;
    setModalErro(null);
    const ok = await decidir(
      id,
      () => (modo === 'negar' ? AdminPedidosIaApiService.negar(id, texto) : AdminPedidosIaApiService.descrever(id, texto)),
      setModalErro,
    );
    if (ok) setModal(null);
  };

  if (access.status === 'idle' || access.status === 'loading') {
    return <p className="text-sm text-[#404040]">{t('admin.pedidosIa.loading')}</p>;
  }
  if (access.status === 'error') {
    return <div role="alert" className="text-sm font-medium text-[#7A0C0C]">{t('admin.pedidosIa.authzError')}</div>;
  }
  if (!visible) return <Navigate to="/admin" replace />;

  const campo = 'min-h-[44px] rounded-lg border-2 border-[#595959] bg-white px-2 text-sm text-[#1A1A1A]';

  return (
    <div data-testid="pedidos-ia-page" className="mx-auto w-full max-w-4xl space-y-4 overflow-x-hidden">
      <div>
        <h1 className="text-2xl font-semibold text-[#1A1A1A]">{t('admin.pedidosIa.title')}</h1>
        <p className="text-sm text-[#404040]">{t('admin.pedidosIa.subtitle')}</p>
      </div>

      {!podeDecidir && (
        <div className="rounded-lg border border-[#8A6100] bg-[#FFF4D6] px-4 py-2 text-xs text-[#4A3300]" data-testid="pedidos-somente-leitura">
          {t('admin.pedidosIa.readOnlyNotice')}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-[#262626]">
          {t('admin.pedidosIa.filters.area')}
          <select data-testid="pedidos-filtro-area" className={campo} value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">{t('admin.pedidosIa.filters.todas')}</option>
            {areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-[#262626]">
          {t('admin.pedidosIa.filters.status')}
          <select data-testid="pedidos-filtro-status" className={campo} value={status} onChange={(e) => setStatus(e.target.value as PedidoStatus | '')}>
            <option value="">{t('admin.pedidosIa.filters.todos')}</option>
            {STATUS.map((s) => <option key={s} value={s}>{t(`admin.pedidosIa.status.${s}`)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-[#262626]">
          {t('admin.pedidosIa.filters.ordem')}
          <select data-testid="pedidos-ordem" className={campo} value={ordem} onChange={(e) => setOrdem(e.target.value as Ordem)}>
            <option value="novos">{t('admin.pedidosIa.filters.maisNovos')}</option>
            <option value="antigos">{t('admin.pedidosIa.filters.maisAntigos')}</option>
          </select>
        </label>
      </div>

      {carga === 'loading' && <p className="text-sm text-[#404040]">{t('admin.pedidosIa.loading')}</p>}
      {carga === 'error' && (
        <div role="alert" data-testid="pedidos-erro" className="text-sm font-medium text-[#7A0C0C]">{t('admin.pedidosIa.errors.generic')}</div>
      )}
      {carga === 'ready' && ordenados.length === 0 && (
        <p data-testid="pedidos-vazio" className="text-sm text-[#404040]">{t('admin.pedidosIa.empty')}</p>
      )}
      {carga === 'ready' && (
        <div className="space-y-3" data-testid="pedidos-lista">
          {ordenados.map((p) => (
            <PedidoPost
              key={p.id}
              pedido={p}
              podeDecidir={podeDecidir}
              ocupado={ocupado === p.id}
              erroKey={erros[p.id] || null}
              onAceitar={() => void aceitar(p.id)}
              onNegar={() => { setModalErro(null); setModal({ id: p.id, modo: 'negar' }); }}
              onDescrever={() => { setModalErro(null); setModal({ id: p.id, modo: 'descrever' }); }}
            />
          ))}
        </div>
      )}

      {modal && (
        <DecisaoModal
          modo={modal.modo}
          enviando={ocupado === modal.id}
          erroKey={modalErro}
          onConfirmar={(txt) => void confirmarModal(txt)}
          onCancelar={() => setModal(null)}
        />
      )}
    </div>
  );
}
