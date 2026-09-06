/**
 * A linha do tempo da Tela 4 — e a citação da Meta dentro dela.
 *
 * 🔒 A HIERARQUIA DE LEITURA É O DESENHO INTEIRO AQUI. Quem abre esta tela
 * depois de uma recusa quer saber DUAS coisas, nesta ordem: o que está errado e
 * como consertar — ambas em prosa, nas palavras de quem recusou. O código cru
 * (`INVALID_FORMAT`) fica por último e em fonte menor: ele só serve a quem vai
 * abrir um chamado no suporte, e para essa pessoa ele precisa ser copiável, não
 * proeminente.
 *
 * ⚠️ O texto da citação é DA META, não nosso. Nada aqui reescreve, resume ou
 * "melhora" o que ela mandou — quando ela não manda nada, a tela diz que não
 * mandou, em vez de a gente adivinhar um motivo plausível.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';
import { dataLegivel } from './templateCatalogView';
import type { EventoLinhaDoTempo, Marcador } from './templateCatalogHistorico';
import { demoraAteOVeredito } from './templateCatalogHistorico';

/** As cores dos marcos vêm do tema — turquoise/pink-cancel/wait, como no desenho. */
const COR: Record<Marcador, string> = {
  done: 'bg-turquoise shadow-[0_0_0_1px_#3EEBD6]',
  bad: 'bg-pink-cancel shadow-[0_0_0_1px_#F96B8C]',
  now: 'bg-wait shadow-[0_0_0_1px_#FFC53B]',
};

/** Os estados em que a Meta disse não — só neles a citação faz sentido. */
const RECUSA = new Set(['recusado', 'pausado', 'desligado']);

export function TemplateCatalogTimeline({
  eventos, row,
}: { eventos: EventoLinhaDoTempo[]; row: TemplateCatalogRow }): JSX.Element {
  const { t } = useTranslation();
  const demora = demoraAteOVeredito(eventos);

  if (eventos.length === 0) {
    /*
     * 🔒 Vazio é uma RESPOSTA, não um buraco. Acontece com a mensagem que veio
     * do Console da Twilio e que a Meta nunca nos respondeu: não há marco nenhum
     * a mostrar, e dizer isso é diferente de a tela parecer não ter carregado.
     */
    return (
      <div data-testid="tc-detalhe-sem-historico" className="rounded-card border border-gray-300 px-4 py-6">
        <Text size="sm" color="secondary">{t('admin.templateCatalog.timeline.semHistorico')}</Text>
      </div>
    );
  }

  return (
    <ul className="m-0 flex list-none flex-col p-0" data-testid="tc-detalhe-timeline">
      {eventos.map((e, i) => {
        const ultimo = i === eventos.length - 1;
        return (
          <li key={e.tipo} className="relative flex gap-3.5 pb-5" data-testid={`tc-detalhe-evento-${e.tipo}`}>
            {/* O fio que liga os marcos. Não sai do último — linha pendurada no
                vazio sugere um evento que ainda vem, e pode não vir. */}
            {!ultimo && <span aria-hidden="true" className="absolute left-[6.5px] top-4 bottom-0 w-px bg-gray-300" />}
            <span
              aria-hidden="true"
              className={`relative mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border-[2.5px] border-white ${COR[e.marcador]}`}
            />
            <div className="min-w-0">
              <Text size="xs" weight="medium" color="primary">
                {t(`admin.templateCatalog.timeline.${e.tipo}`)}
              </Text>
              <Text size="2xs" color="secondary">
                {/* Autor e instante lado a lado. Falta um dos dois? mostra o
                    outro — meia informação verdadeira vale mais que nenhuma. */}
                {[e.quem, dataLegivel(e.quandoISO)].filter(Boolean).join(' · ') || t('admin.templateCatalog.never')}
                {ultimo && demora !== null && RECUSA.has(e.tipo) && (
                  <span data-testid="tc-detalhe-demora">
                    {' · '}{t(`admin.templateCatalog.timeline.depois.${demora.unidade}`, { count: demora.valor })}
                  </span>
                )}
              </Text>

              {RECUSA.has(e.tipo) && <CitacaoDaMeta row={row} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * O que a Meta disse, na ordem em que se lê.
 *
 * 🔒 Os `data-testid` daqui (`tc-detalhe-motivo`, `-explicacao`,
 * `-sem-explicacao`) são os MESMOS que o drawer usava. Não é preguiça de
 * nomear: são as asserções que já existiam e que continuam valendo palavra por
 * palavra — mudar o nome faria a suíte parecer verde por ter parado de olhar.
 */
function CitacaoDaMeta({ row }: { row: TemplateCatalogRow }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      data-testid="tc-detalhe-citacao"
      className="mt-1.5 rounded-r-lg border-l-2 border-pink-cancel bg-[#FDF3F7] px-[11px] py-2 text-[11.5px] font-normal leading-[1.5] text-[#8E1230]"
    >
      {row.metaReason && (
        <Text size="xs" weight="medium" color="inherit" className="mb-1 block text-[#8E1230]">
          <span data-testid="tc-detalhe-motivo">
            {t(`admin.templateCatalog.reason.${row.metaReason}`, row.metaReason)}
          </span>
        </Text>
      )}

      {row.metaDetail ? (
        <Text size="xs" color="inherit" className="text-[#8E1230]">
          <span data-testid="tc-detalhe-explicacao">«{row.metaDetail}»</span>
        </Text>
      ) : (
        /*
         * 🔒 QUANDO A META NÃO EXPLICA, A TELA DIZ ISSO. No drawer este campo
         * SUMIA quando vazio, e o produto ficava sem nenhum lugar registrando
         * que não veio detalhe — quem olhasse concluiria que ninguém tinha
         * procurado. Aqui a ausência é dita.
         */
        <Text size="xs" color="secondary">
          <span data-testid="tc-detalhe-sem-explicacao">{t('admin.templateCatalog.metaSinDetalle')}</span>
        </Text>
      )}

      {/* O código cru por último e menor: serve ao chamado no suporte, não à
          leitura. E vem marcado como sendo da Meta, sem edição nossa. */}
      {row.metaReason && (
        <Text size="xs" color="secondary" className="mt-2 block opacity-75">
          <span data-testid="tc-detalhe-motivo-cru">
            reason: {row.metaReason} · {t('admin.templateCatalog.timeline.veioDaMeta')}
          </span>
        </Text>
      )}
    </div>
  );
}
