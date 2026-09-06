/**
 * As quatro ações de um rascunho — editar, enviar, duplicar e arquivar — agora
 * no detalhe da mensagem (Tela 4), que é onde o desenho as põe.
 *
 * 🔒 POR QUE ELAS MUDARAM DE TELA. Elas viviam num bloco "Borradores guardados"
 * no pé do compositor, e esse bloco não existe na maquete. Ele existia por uma
 * razão que já não vale: era a ÚNICA porta para reabrir um rascunho salvo,
 * porque o catálogo não os mostrava. Desde que `GET /template-catalog` une as
 * duas tabelas, o rascunho é uma linha do catálogo como qualquer outra — e o
 * lugar de agir sobre uma linha é a página dela.
 *
 * O ganho não é estética: no compositor a lista ficava ABAIXO do formulário que
 * a pessoa está preenchendo, misturando "o que estou escrevendo agora" com "o
 * que já escrevi antes". Duas perguntas diferentes na mesma tela, e a de baixo
 * só aparecia depois de rolar.
 *
 * 🔒 SÃO DOIS COMPONENTES, e a divisão segue a maquete, não a conveniência. Na
 * Tela 4 a coluna da direita lê de cima para baixo: primeiro em que pé está,
 * depois o que dá para fazer explicado em palavras, e só então os botões. Um
 * cartão único com estado e botões dentro empurraria o "Qué podés hacer" para
 * DEPOIS dos botões — a explicação atrás da ação que ela explica.
 *
 * ⚠️ A ÚLTIMA FALHA DE ENVIO VEM JUNTO. `submissionError` não aparece em nenhum
 * outro lugar desta página — nem na linha do tempo, nem nos campos técnicos. Se
 * ela ficasse para trás na mudança de tela, o erro que impediu a submissão
 * passaria a existir só no banco, e a pessoa veria "não enviado" sem motivo.
 */
import { useState, type JSX } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Button, buttonClasses } from '@presentation/components/atoms/Button';
import {
  AdminTemplateDraftsApiService,
  DraftApiError,
  type TemplateDraft,
} from '@infrastructure/http/AdminTemplateDraftsApiService';
import { TemplateDraftConfirmDialog } from './TemplateDraftConfirmDialog';
import { urlDeEdicao } from './templateDraftsView';

/**
 * Em que pé está o rascunho — a tira que abre a coluna.
 *
 * 🔒 É DIFERENTE DO SELO DO CABEÇALHO. O selo mostra o que a Meta respondeu;
 * aqui interessa o passo do NOSSO fluxo: gravado, submetido, ou decidido. Antes
 * de 01/09 tudo que fora enviado dizia "esperando" para sempre, mesmo já
 * aprovado — o Gabriel viu isso na tela de produção.
 */
export function TemplateCatalogDraftEstado({ rascunho }: { rascunho: TemplateDraft }): JSX.Element {
  const { t } = useTranslation();

  const estado = rascunho.status === 'decided'
    ? t(`admin.templateDrafts.veredito.${rascunho.metaStatus}`, String(rascunho.metaStatus))
    : rascunho.status === 'submitted'
      ? t('admin.templateDrafts.estado.submitted')
      : t('admin.templateDrafts.estado.draft');

  return (
    <div
      className="rounded-[14px] border border-gray-300 bg-[#F7F5FB] px-4 py-3 text-[14px] leading-[1.5] text-primary"
      data-testid="tc-detalhe-rascunho"
    >
      <Text size="xs" weight="semibold" color="primary" className="block">
        {t('admin.templateCatalog.rascunho.titulo')}
      </Text>
      <Text size="xs" color="secondary" className="block">
        <span data-testid="tc-rascunho-estado">{estado}</span>
      </Text>

      {rascunho.status === 'decided' && rascunho.metaReason && (
        <Text size="xs" color="inherit" className="mt-1 block text-[#8E1230]">
          <span data-testid="tc-rascunho-motivo">
            {t(`admin.templateCatalog.reason.${rascunho.metaReason}`, rascunho.metaReason)}
          </span>
        </Text>
      )}
      {rascunho.submissionError && (
        <Text size="xs" color="inherit" className="mt-1 block text-[#8E1230]">
          <span data-testid="tc-rascunho-falha">
            {t('admin.templateDrafts.ultimaFalha', { erro: rascunho.submissionError })}
          </span>
        </Text>
      )}
    </div>
  );
}

export interface DraftActionsProps {
  rascunho: TemplateDraft;
  /** Recarrega a página depois de arquivar ou enviar — a linha muda de estado. */
  onMudou: () => void;
}

export function TemplateCatalogDraftActions({ rascunho, onMudou }: DraftActionsProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erroKey, setErroKey] = useState<string | null>(null);
  const [erroBruto, setErroBruto] = useState<string | null>(null);

  const editavel = rascunho.status === 'draft';

  const enviar = async (): Promise<void> => {
    setEnviando(true);
    setErroKey(null); setErroBruto(null);
    try {
      await AdminTemplateDraftsApiService.submitDraft(rascunho.id);
      setConfirmando(false);
      onMudou();
    } catch (e: unknown) {
      setConfirmando(false);
      if (e instanceof DraftApiError) {
        if (e.status === 503) setErroKey(`admin.templateDrafts.indisponivel.${e.motivo}`);
        else if (e.codigo) setErroKey(`admin.templateDrafts.envioErro.${e.codigo}`);
        else setErroBruto(e.message);
      } else {
        setErroKey('admin.templateDrafts.erroEnviar');
      }
    } finally {
      setEnviando(false);
    }
  };

  /*
   * Duplicar leva DIRETO ao compositor com o clone aberto. Duplicar e ficar na
   * mesma tela deixaria a pessoa com um rascunho novo em algum lugar e nenhuma
   * indicação de onde — o ato só termina quando ela pode corrigir o texto.
   */
  const duplicar = async (): Promise<void> => {
    setErroKey(null); setErroBruto(null);
    try {
      const r = await AdminTemplateDraftsApiService.duplicateDraft(rascunho.id);
      navigate(urlDeEdicao(r.draft.id));
    } catch { setErroKey('admin.templateDrafts.erroDuplicar'); }
  };

  const arquivar = async (): Promise<void> => {
    setErroKey(null); setErroBruto(null);
    try {
      await AdminTemplateDraftsApiService.archiveDraft(rascunho.id);
      onMudou();
    } catch { setErroKey('admin.templateDrafts.erroArquivar'); }
  };

  return (
    <>
      {(erroKey || erroBruto) && (
        <Text size="xs" color="inherit" className="block text-[#8E1230]">
          <span data-testid="tc-rascunho-erro">{erroKey ? t(erroKey) : erroBruto}</span>
        </Text>
      )}

      {/*
        * 🔒 Submetido não se edita nem se reenvia: o texto foi para a Meta e
        * reescrevê-lo por baixo faria o banco discordar do que está lá fora. O
        * caminho de correção é duplicar — e é por isso que ele aparece
        * justamente quando editar desaparece.
        *
        * O botão CHEIO é sempre o passo recomendado do momento: enviar, enquanto
        * ainda dá; duplicar, depois que a Meta já respondeu. Deixar os dois
        * outline empataria o que fazer com o que desfazer.
        */}
      {editavel ? (
        <>
          <Button size="compact" fullWidth data-testid="tc-rascunho-enviar" onClick={() => setConfirmando(true)}>
            {t('admin.templateDrafts.enviar')}
          </Button>
          <Link
            to={urlDeEdicao(rascunho.id)}
            data-testid="tc-rascunho-editar"
            className={`${buttonClasses({ size: 'compact', variant: 'outline', fullWidth: true })} bg-white`}
          >
            {t('admin.templateDrafts.editar')}
          </Link>
        </>
      ) : (
        <Button size="compact" fullWidth data-testid="tc-rascunho-duplicar" onClick={() => void duplicar()}>
          {t('admin.templateDrafts.duplicar')}
        </Button>
      )}
      <Button
        size="compact" variant="outline" fullWidth className="bg-white"
        data-testid="tc-rascunho-arquivar" onClick={() => void arquivar()}
      >
        {t('admin.templateDrafts.arquivar')}
      </Button>

      {confirmando && (
        <TemplateDraftConfirmDialog
          draft={rascunho}
          enviando={enviando}
          onConfirmar={() => void enviar()}
          onCancelar={() => setConfirmando(false)}
        />
      )}
    </>
  );
}
