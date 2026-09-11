import { useTranslation } from 'react-i18next';
import { usePostularseAction } from '@presentation/hooks/usePostularseAction';
import { IncompleteRegistrationModal } from '@presentation/pages/public/components/IncompleteRegistrationModal';
import { PostularseErrorModal } from '@presentation/pages/public/components/PostularseErrorModal';
import type { Job } from './jobsConstants';

interface JobCardProps {
  job: Job;
  /** Fase 4/DD5 — MESMO rótulo pra todo card (depende só da worker). */
  applyLabel: string;
  onViewDetails: (job: Job) => void;
}

/**
 * JobCard — um card de vaga da home.
 *
 * "Postularse" passa pelo servidor (`usePostularseAction`, MESMO hook de
 * `/vacantes/:id`, canal fixo `'site'` — não é clique via UTM). Só existe
 * quando o job tem `whatsappLink` E `id` (job_postings.id real — só a API
 * pública fornece; o scraper legado não tem, e sem UUID não dá pra checar
 * elegibilidade real nem criar WJA — o hook modelaria isso como
 * `not_available`, mas aqui nem chega a renderizar o botão pra evitar um
 * clique morto).
 *
 * "Ver Detalles" (`onViewDetails`, dono é `JobsEmbeddedSection`) NUNCA passa
 * por este hook — não chama track-channel (condição C1 do parecer lex).
 */
export function JobCard({ job, applyLabel, onViewDetails }: JobCardProps): JSX.Element {
  const { t } = useTranslation();
  const canTrackApply = Boolean(job.whatsappLink && job.id);
  const { state, missingFields, postularse, dismissModal } = usePostularseAction(
    job.whatsappLink || null,
    job.id || null,
    'site',
  );

  return (
    <div
      data-testid="job-card"
      className="border border-[#d9d9d9] rounded-[10px] p-4 hover:border-[#180149] transition-colors bg-white"
    >
      {/*
        Defeito do print (depois-1-home-celular.png, 390px): botão/badge na
        MESMA linha (flex row) em toda largura fazia o botão verde (o de
        rótulo mais longo, Fase 4/DD5 — "Completá N pasos para postularte")
        empurrar o container do badge pra largura zero (flex-1 min-w-0
        encolhendo) — o badge ficava por baixo do botão, e "Ver Detalles"
        saía cortado pela borda direita do card. Em telas estreitas (abaixo
        de `sm`) os dois blocos empilham (flex-col); a partir de `sm` volta a
        ser row, lado a lado, como no desktop hoje. Mesmo padrão de
        breakpoint mobile-first já usado nos filtros (`grid-cols-1
        md:grid-cols-2`) e na `JobsEmbeddedSection` de modo geral.
      */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between mb-3 gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span
              data-testid="job-code-badge"
              className="px-2 py-1 bg-[#180149] text-white text-xs rounded font-medium font-lexend"
            >
              {job.code}
            </span>
            <span className="text-xs text-[#737373] capitalize font-lexend font-medium">
              {job.workerType.split(', ').map(p => t(`jobs.profession.${p}`, { defaultValue: p })).join(', ')}
            </span>
          </div>
          <h3 className="font-semibold text-[#180149] text-sm font-lexend">
            {[job.barrio, job.localidad, job.provincia].filter(Boolean).join(' · ')}
          </h3>
        </div>
        {/* `w-full` no mobile empilhado: os botões ocupam a largura do card
            (podem quebrar linha entre si via flex-wrap, e o rótulo longo
            pode quebrar em 2 linhas dentro do próprio botão — sem truncar).
            `sm:w-auto sm:flex-shrink-0` devolve o comportamento de hoje a
            partir do breakpoint `sm`. */}
        <div className="flex flex-wrap gap-2 w-full sm:w-auto sm:flex-shrink-0">
          {/*
            🔒 Achado do gate (11/09, rodada 3): `bg-[#25d366]`
            (verde claro do ícone do WhatsApp) media 1,98:1 com
            texto branco — abaixo do mínimo WCAG AA (4,5:1) — e a
            partir da Fase 4/DD5 o botão carrega a FRASE inteira da
            entrega, não mais uma palavra curta. Decisão de
            desenho do orquestrador: mantém a identidade WhatsApp
            com o verde-escuro da marca — `#075E54` (7,67:1 em
            repouso, hover `#054C44` ~9,89:1).
          */}
          {canTrackApply && (
            <button
              type="button"
              onClick={() => { void postularse(); }}
              disabled={state === 'loading'}
              className="px-3 py-1.5 bg-[#075E54] text-white text-xs rounded hover:bg-[#054C44] transition-colors font-lexend font-medium disabled:opacity-70"
            >
              {applyLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => onViewDetails(job)}
            className="px-3 py-1.5 bg-[#180149] text-white text-xs rounded hover:bg-[#2a014d] transition-colors font-lexend font-medium"
          >
            {t('jobs.viewDetails')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-[#737373] mb-3 font-lexend font-medium">
        <div>
          <span className="text-[#180149] font-semibold">{t('jobs.fields.sex')}:</span>{' '}
          {t(`jobs.sex.${job.workerSex}`, { defaultValue: job.workerSex })}
        </div>
        <div>
          <span className="text-[#180149] font-semibold">{t('jobs.fields.ageRange')}:</span> {job.ageRange}
        </div>
        <div>
          <span className="text-[#180149] font-semibold">{t('jobs.fields.serviceType')}:</span> {job.service}
        </div>
        <div>
          <span className="text-[#180149] font-semibold">{t('jobs.fields.schedule')}:</span> {job.daysAndHours.substring(0, 30)}...
        </div>
      </div>

      <div className="text-xs text-[#737373] font-lexend font-medium">
        <p className="mb-1"><span className="text-[#180149] font-semibold">{t('jobs.fields.profile')}:</span> {job.profile}</p>
        <p className="line-clamp-2">{job.description}</p>
      </div>

      {state === 'incomplete' && (
        <IncompleteRegistrationModal missingFields={missingFields} onClose={dismissModal} />
      )}

      {state === 'error' && (
        <PostularseErrorModal onClose={dismissModal} body={t('publicVacancy.errorModal.bodyHome')} />
      )}
    </div>
  );
}
