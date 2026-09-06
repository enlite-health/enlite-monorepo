/**
 * "Antes de enviar a Meta" — a lista de verificação da Tela 2.
 *
 * 🔒 CADA ITEM CORRESPONDE A UM MOTIVO REAL DE RECUSA, e nenhum deles é
 * calculado aqui: os estados vêm de `POST /template-drafts/validar`, que roda
 * `validarRascunho` — a MESMA função que decide na hora de gravar. A lista que
 * a pessoa lê enquanto escreve é a que manda; se fossem duas réguas, ela
 * aprenderia a ignorar as duas.
 *
 * ⚠️ AMARELO NÃO É VERMELHO. `falta` é aviso: grava e envia mesmo assim (a
 * cláusula de baja e a tradução pendente são os dois casos). `impede` é
 * bloqueio: não grava. Pintar os dois da mesma cor faria a pessoa parar de
 * distinguir "preciso resolver" de "posso seguir" — e é exatamente por isso que
 * `Problema` ganhou `gravidade` no backend.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { contagemDaLista, type ItemDeVerificacao } from './templateComposerView';

/** Ícone e cor por estado — turquesa, âmbar, rosa: as três do tema. */
const ESTILO: Record<ItemDeVerificacao['estado'], { ic: string; classe: string }> = {
  ok: { ic: '✓', classe: 'bg-turquoise/35 text-[#0B5C4E]' },
  falta: { ic: '!', classe: 'bg-wait/40 text-[#7A5200]' },
  impede: { ic: '✕', classe: 'bg-pink-cancel/30 text-[#8E1230]' },
};

export function TemplateComposerChecklist({
  itens, categoria,
}: { itens: ItemDeVerificacao[]; categoria: string }): JSX.Element {
  const { t } = useTranslation();
  const { ok, total } = contagemDaLista(itens);

  /*
   * 🔒 A ESCALA DECLARADA NO CARTÃO, não herdada. Sem isto ele vinha com os
   * 16px/24px do body e a caixa de linha de cada item ficava maior que a do
   * desenho, mesmo com o `<Text size="xs">` certo dentro — medido pelo
   * pixel-loop, não visto a olho. Raio 14px é o do `.check` da maquete;
   * `rounded-card` do tema é 20.
   */
  return (
    <div
      className="rounded-[14px] border border-gray-300 bg-white px-4 py-4 text-[14px] leading-[1.5] text-primary"
      data-testid="td-checklist"
    >
      <div className="mb-3 flex items-center justify-between gap-2 text-[12px] font-semibold leading-[1.5]">
        <Text as="span" size="xs" weight="semibold" color="primary">
          {t('admin.templateDrafts.checklist.titulo')}
        </Text>
        {/* A contagem é o resumo que se lê de longe: "6 de 7" diz o tamanho do
            que falta sem obrigar a varrer a lista item por item. */}
        <Text as="span" size="xs" color="secondary">
          <span data-testid="td-checklist-contagem">{ok} / {total}</span>
        </Text>
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {itens.map((i) => (
          <li key={i.chave} className="flex items-start gap-2.5" data-testid={`td-check-${i.chave}`}>
            <span
              aria-hidden="true"
              className={`mt-px flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full ${ESTILO[i.estado].classe}`}
            >
              <Text as="span" size="xs" weight="semibold" color="inherit">{ESTILO[i.estado].ic}</Text>
            </span>
            <div className="min-w-0">
              {/* O estado entra no `data-` para o teste poder afirmar a COR sem
                  depender da classe do Tailwind, que muda com o tema. */}
              <span data-estado={i.estado}>
                <Text size="xs" weight="medium" color="primary">
                  {t(`admin.templateDrafts.checklist.${i.chave}.titulo`, { ...i.dados, categoria })}
                </Text>
              </span>
              <Text size="xs" color="secondary">
                {t(`admin.templateDrafts.checklist.${i.chave}.${i.estado === 'ok' ? 'ok' : 'falta'}`, { ...i.dados, categoria })}
              </Text>
            </div>
          </li>
        ))}
      </ul>

      <Text size="xs" color="secondary" className="mt-3 block border-t border-gray-300 pt-2.5">
        {t('admin.templateDrafts.checklist.fonte')}
      </Text>
    </div>
  );
}
