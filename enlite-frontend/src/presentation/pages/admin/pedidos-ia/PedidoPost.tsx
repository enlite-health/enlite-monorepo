import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronDown, MessageSquare, X } from 'lucide-react';
import type { Pedido, PedidoStatus } from '@infrastructure/http/AdminPedidosIaApiService';

const STATUS_COR: Record<PedidoStatus, string> = {
  novo: 'bg-[#E6F0FF] text-[#0B2E6B]',
  aceito: 'bg-[#E3F4E8] text-[#0F3D20]',
  negado: 'bg-[#F4E4E4] text-[#5C0A0A]',
  redirecionado: 'bg-[#F5ECD6] text-[#4A3300]',
};

interface Props {
  pedido: Pedido;
  /** `pedidos_ia:decidir` — sem ela os 3 botões NÃO existem na árvore. */
  podeDecidir: boolean;
  ocupado: boolean;
  erroKey: string | null;
  onAceitar: () => void;
  onNegar: () => void;
  onDescrever: () => void;
}

function Idade({ horas }: { horas: number }): JSX.Element {
  const { t } = useTranslation();
  const h = Math.max(0, Math.floor(horas));
  return <>{h < 48 ? t('admin.pedidosIa.age.hours', { count: h }) : t('admin.pedidosIa.age.days', { count: Math.floor(h / 24) })}</>;
}

/** Um pedido como POST: assunto, quem/onde/há quanto, atitude proposta e os 3 botões. */
export function PedidoPost({ pedido, podeDecidir, ocupado, erroKey, onAceitar, onNegar, onDescrever }: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const [aberto, setAberto] = useState(false);
  const grave = pedido.grave_gatilho !== 'nenhum';
  const decidido = pedido.status === 'aceito' || pedido.status === 'negado';
  const a = pedido.atitude_atual;
  const quando = (ts: string) => new Date(ts).toLocaleString(i18n?.language === 'pt-BR' ? 'pt-BR' : 'es-AR');
  const badge = 'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold';

  return (
    <article
      data-testid={`pedido-post-${pedido.id}`}
      data-status={pedido.status}
      className="rounded-[20px] border-2 border-[#595959] bg-white p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        {pedido.status === 'novo' && (
          <span data-testid="pedido-novo" className={`${badge} bg-[#0B2E6B] text-white`}>
            {t('admin.pedidosIa.badge.novo')}
          </span>
        )}
        {grave && (
          <span data-testid="pedido-grave" className={`${badge} bg-[#7A0C0C] text-white`}>
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {t('admin.pedidosIa.badge.grave')}
          </span>
        )}
        <span data-testid="pedido-status" className={`${badge} ${STATUS_COR[pedido.status]}`}>
          {t(`admin.pedidosIa.status.${pedido.status}`)}
        </span>
      </div>

      <h2 className="mt-2 break-words text-lg font-semibold text-[#1A1A1A]">{pedido.assunto}</h2>
      <p className="mt-1 text-sm text-[#404040]">
        {t('admin.pedidosIa.meta.autor')}: {pedido.autor} · {t('admin.pedidosIa.meta.area')}: {pedido.area} · <Idade horas={pedido.idade_h} />
      </p>

      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        data-testid="pedido-toggle"
        className="mt-3 inline-flex min-h-[44px] items-center gap-1 text-sm font-semibold text-[#0B2E6B] underline"
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${aberto ? 'rotate-180' : ''}`} aria-hidden="true" />
        {aberto ? t('admin.pedidosIa.detail.hide') : t('admin.pedidosIa.detail.show')}
      </button>

      {aberto && (
        <div data-testid="pedido-detalhe" className="mt-2 space-y-4 border-t-2 border-[#D9D9D9] pt-3 text-sm text-[#1A1A1A]">
          {pedido.descricao && (
            <section>
              <h3 className="font-semibold">{t('admin.pedidosIa.detail.descricao')}</h3>
              <p className="mt-1 whitespace-pre-wrap break-words text-[#262626]">{pedido.descricao}</p>
            </section>
          )}
          <section>
            <h3 className="font-semibold">{t('admin.pedidosIa.detail.atitude')}</h3>
            {a ? (
              <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
                <dt className="text-[#404040]">{t('admin.pedidosIa.detail.versao')}</dt>
                <dd>{a.versao}</dd>
                <dt className="text-[#404040]">{t('admin.pedidosIa.detail.degrau')}</dt>
                <dd>{a.degrau}</dd>
                <dt className="text-[#404040]">{t('admin.pedidosIa.detail.conteudo')}</dt>
                <dd className="whitespace-pre-wrap break-words">{a.conteudo}</dd>
                <dt className="text-[#404040]">{t('admin.pedidosIa.detail.casoTeste')}</dt>
                <dd className="break-words">{a.caso_teste}</dd>
                <dt className="text-[#404040]">{t('admin.pedidosIa.detail.medicao')}</dt>
                <dd className="break-words">
                  {a.metrica_alvo} · {t('admin.pedidosIa.detail.janela')}: {a.janela}
                </dd>
                <dt className="text-[#404040]">{t('admin.pedidosIa.detail.rollback')}</dt>
                <dd className="break-words">{a.gatilho_rollback}</dd>
              </dl>
            ) : (
              <p className="mt-1 text-[#404040]">{t('admin.pedidosIa.detail.semAtitude')}</p>
            )}
          </section>
          <section>
            <h3 className="font-semibold">{t('admin.pedidosIa.detail.historico')}</h3>
            {pedido.eventos.length === 0 ? (
              <p className="mt-1 text-[#404040]">{t('admin.pedidosIa.detail.semEventos')}</p>
            ) : (
              <ul data-testid="pedido-eventos" className="mt-1 space-y-2">
                {pedido.eventos.map((e, i) => (
                  <li key={`${e.ts}-${i}`} className="break-words rounded-lg bg-[#F7F7F7] p-2">
                    <span className="font-semibold">{t(`admin.pedidosIa.acao.${e.acao}`)}</span>
                    {' · '}
                    {t(`admin.pedidosIa.actor.${e.actor_kind}`)} {e.actor_uid} · {quando(e.ts)}
                    {(e.motivo || e.comentario) && <p className="mt-1 text-[#262626]">{e.motivo ?? e.comentario}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {erroKey && (
        <p role="alert" data-testid="pedido-erro" className="mt-3 text-sm font-medium text-[#7A0C0C]">
          {t(erroKey)}
        </p>
      )}

      {podeDecidir && !decidido && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row" data-testid="pedido-acoes">
          <button
            type="button"
            data-testid="pedido-aceitar"
            disabled={ocupado}
            onClick={onAceitar}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-[#14532D] px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            {t('admin.pedidosIa.actions.aceitar')}
          </button>
          <button
            type="button"
            data-testid="pedido-negar"
            disabled={ocupado}
            onClick={onNegar}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-[#7A0C0C] px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            {t('admin.pedidosIa.actions.negar')}
          </button>
          <button
            type="button"
            data-testid="pedido-descrever"
            disabled={ocupado}
            onClick={onDescrever}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border-2 border-[#262626] bg-white px-4 text-sm font-semibold text-[#262626] disabled:opacity-60"
          >
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
            {t('admin.pedidosIa.actions.descrever')}
          </button>
        </div>
      )}
    </article>
  );
}
