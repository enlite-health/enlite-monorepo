/**
 * A confirmação do envio (spec 010, F2 2.4) — Tela 3 do desenho de 31/08.
 *
 * ⚠️ Existe por um motivo só: ENUMERAR o que se torna irreversível antes do
 * clique. A spec pede isso com todas as letras — "vê uma confirmação que enumera
 * o que se torna irreversível, e o botão de envio só habilita após confirmação
 * explícita". Um `window.confirm('tem certeza?')` cumpriria a forma e não a
 * substância: "tem certeza" não informa nada a quem não sabe o que vai acontecer.
 *
 * 🔒 POR QUE VIROU MODAL DE VERDADE (01/09/2026, emenda do Gabriel).
 * Antes isto era uma caixa `<div>` inline no fluxo da página — e a prova de que
 * o formato estava errado era o próprio código: a caixa precisava de um
 * `scrollIntoView` para ser vista, porque nascia fora do campo de visão de quem
 * tinha acabado de clicar. Uma modal não precisa; ela É o campo de visão.
 *
 * 🔒 E POR QUE O CHECKBOX NÃO É ENFEITE. Sem ele o ato irreversível ficava a UM
 * clique do botão "Enviar" da lista — o mesmo gesto, duas vezes, sem nada entre
 * os dois. O desenho põe o botão em `aria-disabled` até a pessoa marcar que leu.
 * Isso transforma "cliquei sem querer" em "li e confirmei", que é a única coisa
 * que uma confirmação existe para comprar.
 *
 * Componente separado também porque a página bateu no teto de 400 linhas — e o
 * teto existe justamente para forçar esse tipo de corte.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
// Os mesmos tokens do `<Button>`: aqui são `<button>` cru porque a modal não
// usa o atom (ela precisa da variante `danger` e do estado travado pelo
// checkbox), mas o TAMANHO tem de ser o mesmo do resto das telas.
import { buttonClasses } from '@presentation/components/atoms/Button';
import type { TemplateDraft } from '@infrastructure/http/AdminTemplateDraftsApiService';

/**
 * Os fatos irreversíveis, na ordem em que doem.
 *
 * ⚠️ São CINCO, e o desenho mostra quatro. O quinto é o `nome`: "o nome fica
 * ocupado na conta de WhatsApp para sempre, mesmo se a Meta recusar". É verdade
 * medida e já estava na tela antes deste redesenho — apagá-la para bater com a
 * maquete seria piorar o produto em nome da semelhança. Fica, e fica em
 * primeiro lugar, porque é a única que continua doendo mesmo quando dá errado.
 */
const CONSEQUENCIAS = ['nome', 'edicao', 'idiomaFixo', 'prazo', 'soUmIdioma'] as const;

/** Quanto do corpo cabe no resumo antes das reticências. O desenho mostra uma linha. */
const RECAP_CHARS = 120;

export interface TemplateDraftConfirmDialogProps {
  draft: TemplateDraft;
  enviando: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
}

export function TemplateDraftConfirmDialog({
  draft, enviando, onConfirmar, onCancelar,
}: TemplateDraftConfirmDialogProps): JSX.Element {
  const { t } = useTranslation();
  /**
   * 🔒 Nasce `false` a cada abertura e nunca é reaproveitado: o componente
   * monta e desmonta com o diálogo (`{confirmando && <Dialog/>}`), então não há
   * caminho em que a marcação de um envio anterior autorize o seguinte.
   */
  const [confirmado, setConfirmado] = useState(false);

  // Escape fecha — mesma convenção do ConfirmValidationModal e do HelpDrawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCancelar(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancelar]);

  const idioma = t(`admin.templateDrafts.idioma.${draft.language}`, draft.language);
  const trecho = draft.body.length > RECAP_CHARS
    ? `${draft.body.slice(0, RECAP_CHARS).trimEnd()}…`
    : draft.body;
  const podeEnviar = confirmado && !enviando;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      data-testid="td-confirmar"
      role="dialog"
      aria-modal="true"
      aria-labelledby="td-confirmar-titulo"
      onClick={onCancelar}
    >
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-card bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-gray-300 px-6 pb-3.5 pt-5">
          <Heading level={2} id="td-confirmar-titulo" className="text-[17px]">
            {t('admin.templateDrafts.confirmar.titulo')}
          </Heading>
          <Text size="xs" color="secondary">{t('admin.templateDrafts.confirmar.subtitulo')}</Text>
        </div>

        <div className="px-6 pb-1.5 pt-4">
          {/* 🔒 O RECAP É O QUE SE ESTÁ CONFIRMANDO. Sem ele a pessoa marca "li o
              texto" sem ter o texto na frente — a caixa de confirmação viraria
              uma pergunta sobre algo que não está na tela. */}
          <div className="mb-4 rounded-[10px] bg-[#F7F5FB] px-3.5 py-3" data-testid="td-confirmar-recap">
            <Text size="xs" color="inherit" className="text-primary">
              <b>{draft.slug}</b> · {idioma} · {draft.category}
            </Text>
            <Text size="xs" color="secondary" className="mt-1 block">«{trecho}»</Text>
          </div>

          <ul className="mb-4 flex list-none flex-col gap-3 p-0" data-testid="td-confirmar-lista">
            {CONSEQUENCIAS.map((k, i) => (
              <li key={k} className="flex gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-px flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full bg-[#FDE9F6] text-[#C8117F]"
                >
                  <Text as="span" size="xs" weight="semibold" color="inherit">{i + 1}</Text>
                </span>
                {/* 🔒 O TRECHO FORTE ABRE A FRASE, como no desenho. Não é
                    enfeite: cinco parágrafos de mesmo peso numa caixa que a
                    pessoa lê com pressa viram um bloco cinza que ninguém lê. O
                    negrito carrega o fato — "não vai poder editar" — e o resto
                    explica a consequência para quem parar. */}
                <Text size="xs" color="inherit" className="text-primary">
                  <strong className="font-medium">
                    {t(`admin.templateDrafts.confirmar.${k}.forte`, { idioma })}
                  </strong>{' '}
                  {t(`admin.templateDrafts.confirmar.${k}.resto`, { idioma })}
                </Text>
              </li>
            ))}
          </ul>

          <div className="rounded-xl border border-gray-300 bg-[#FBF9FD] px-3.5 py-3">
            <Checkbox
              id="td-confirmar-li"
              data-testid="td-confirmar-li"
              checked={confirmado}
              onChange={(e) => setConfirmado(e.target.checked)}
              label={t('admin.templateDrafts.confirmar.confirmoLeitura')}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 px-6 pb-5 pt-3.5">
          <button
            type="button"
            data-testid="td-confirmar-nao"
            onClick={onCancelar}
            className={buttonClasses({ size: 'compact', variant: 'outline' })}
          >
            {t('admin.templateDrafts.confirmar.nao')}
          </button>
          {/*
            * 🔒 `disabled` DE VERDADE, não só `aria-disabled`. O desenho usa
            * `aria-disabled` porque é maquete estática; num botão vivo isso
            * anunciaria "desabilitado" ao leitor de tela e mesmo assim dispararia
            * no clique. O envio é irreversível: aqui o atributo tem de bloquear,
            * não descrever.
            */}
          <button
            type="button"
            data-testid="td-confirmar-sim"
            disabled={!podeEnviar}
            onClick={onConfirmar}
            className={buttonClasses({ size: 'compact', variant: 'danger' })}
          >
            {enviando ? t('common.loading') : t('admin.templateDrafts.confirmar.sim')}
          </button>
          {/* A trilha de autoria dita em voz alta. O backend grava `submitted_by`
              (migration 299); a tela avisa que grava, antes do clique. */}
          <Text size="xs" color="secondary" className="mt-0.5 basis-full">
            {t('admin.templateDrafts.confirmar.autoria')}
          </Text>
        </div>
      </div>
    </div>
  );
}
