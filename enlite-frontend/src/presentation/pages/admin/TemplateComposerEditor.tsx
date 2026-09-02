/**
 * O editor do corpo da mensagem, com as variáveis como CHIP.
 *
 * 🔒 POR QUE ISTO NÃO É UM `<textarea>`. O desenho de 31/08 mostra
 * «¡Hola [Nombre de la cuidadora]!» e diz com todas as letras que é assim que a
 * pessoa deve ver — nunca `{{worker_name}}`. Não é enfeite: `worker_name` é
 * vocabulário do banco, e a tela inteira desta frente existe para parar de
 * exigir vocabulário de sistema de quem escreve a mensagem. Um `<textarea>` só
 * sabe renderizar texto; o rótulo amigável exige um nó próprio, e nó próprio
 * exige `contenteditable`.
 *
 * 🔒 E O CHIP É ATÔMICO DE PROPÓSITO (`contenteditable="false"`). A variável só
 * funciona inteira: `{{worker_nam}}` é um texto que a Meta aprova e que a
 * Twilio recusa na hora de enviar ("Content Variables parameter is invalid") —
 * a mensagem não sai e ninguém fica sabendo. Deixar apagar uma letra do meio
 * seria oferecer exatamente esse buraco. Backspace remove o chip inteiro.
 *
 * ⚠️ O VALOR CONTINUA SENDO TEXTO. Para fora, este componente é igual ao campo
 * que ele substituiu: recebe `valor` com `{{...}}` cru e devolve o mesmo. O
 * chip existe só entre o olho e o DOM — o que grava, o que valida e o que conta
 * caracteres continua vendo o token, que é o que a Meta vai receber.
 *
 * ⚠️ O TOKEN DESCONHECIDO FICA CRU, e isso é a mesma regra da pré-visualização:
 * se alguém escrever `{{foo}}`, o sistema não sabe preencher, e mostrar um chip
 * bonito prometeria um preenchimento que não vai acontecer.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

/** O que o formulário precisa poder mandar o editor fazer. */
export interface EditorHandle {
  /** Insere texto (ou uma variável) na posição do cursor. */
  inserir: (texto: string) => void;
}

export interface EditorProps {
  id: string;
  valor: string;
  variaveis: readonly string[];
  onChange: (texto: string) => void;
  /**
   * 🔒 `aria-labelledby`, e não `htmlFor`. Um `<label for>` só associa a
   * elementos de formulário; um `<div contenteditable>` não é um deles, e o
   * campo ficaria sem nome acessível — leitor de tela anunciaria "caixa de
   * texto" e mais nada.
   */
  'aria-labelledby': string;
  'data-testid'?: string;
}

const RE_VAR = /\{\{\s*([^}]*?)\s*\}\}/g;

/** DOM → texto. É a única definição do que este editor "vale". */
function serializar(raiz: HTMLElement): string {
  let saida = '';
  const anda = (no: Node): void => {
    if (no.nodeType === Node.TEXT_NODE) { saida += no.nodeValue ?? ''; return; }
    if (!(no instanceof HTMLElement)) return;
    if (no.dataset.var !== undefined) { saida += `{{${no.dataset.var}}}`; return; }
    if (no.tagName === 'BR') { saida += '\n'; return; }
    /*
     * ⚠️ `<div>`/`<p>` viram quebra de linha PORQUE o browser os cria sozinho:
     * apertar Enter dentro de um `contenteditable` produz um bloco novo, não um
     * `<br>`, e sem esta linha dois parágrafos colariam num só na hora de
     * gravar — a mensagem que a Meta recebe não seria a que está na tela.
     */
    const bloco = no.tagName === 'DIV' || no.tagName === 'P';
    if (bloco && saida.length > 0 && !saida.endsWith('\n')) saida += '\n';
    no.childNodes.forEach(anda);
  };
  raiz.childNodes.forEach(anda);
  return saida;
}

export const TemplateComposerEditor = forwardRef<EditorHandle, EditorProps>(
  function TemplateComposerEditor({ id, valor, variaveis, onChange, ...resto }, ref): JSX.Element {
    const { t } = useTranslation();
    const caixa = useRef<HTMLDivElement>(null);
    /** O que ESTE componente escreveu por último — para não se re-renderizar em cima do cursor. */
    const meuTexto = useRef<string | null>(null);
    /**
     * A última posição do cursor DENTRO do editor.
     *
     * 🔒 Clicar num botão da barra tira o foco do editor, e o browser pode
     * recolher a seleção junto. Sem esta lembrança, `{{worker_name}}` ia parar
     * no começo do texto em vez de onde a pessoa estava escrevendo — "¡Hola ▮!"
     * virava "{{worker_name}}¡Hola !". Guardar a seleção antes de perdê-la é o
     * que todo editor de barra de ferramentas faz, e é o que faltava.
     */
    const ultimoRange = useRef<Range | null>(null);

    const rotulo = (nome: string): string => t(`admin.templateDrafts.variavel.${nome}`, nome);

    /** texto → nós. Variável conhecida vira chip; o resto é texto e `<br>`. */
    const fragmentoDe = (texto: string): DocumentFragment => {
      const frag = document.createDocumentFragment();
      const solto = (parte: string): void => {
        // As quebras viram `<br>`: um `\n` dentro de um nó de texto não quebra
        // linha em HTML, e o texto apareceria todo numa tira só.
        parte.split('\n').forEach((linha, i) => {
          if (i > 0) frag.appendChild(document.createElement('br'));
          if (linha.length > 0) frag.appendChild(document.createTextNode(linha));
        });
      };
      let ultimo = 0;
      RE_VAR.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RE_VAR.exec(texto)) !== null) {
        if (m.index > ultimo) solto(texto.slice(ultimo, m.index));
        const nome = m[1];
        if (variaveis.includes(nome)) {
          const chip = document.createElement('span');
          chip.dataset.var = nome;
          chip.setAttribute('contenteditable', 'false');
          chip.setAttribute('data-testid', `td-chip-${nome}`);
          chip.className = 'rounded-[4px] bg-[#F1E9FE] px-1 py-px font-mono text-[11.5px] text-[#5A1FAE]';
          chip.textContent = rotulo(nome);
          frag.appendChild(chip);
        } else {
          solto(m[0]);   // desconhecido: cru, como na pré-visualização
        }
        ultimo = m.index + m[0].length;
      }
      if (ultimo < texto.length) solto(texto.slice(ultimo));
      return frag;
    };

    const lembrarSelecao = (): void => {
      const el = caixa.current;
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0) return;
      if (document.activeElement !== el) return;
      const r = sel.getRangeAt(0);
      if (el.contains(r.commonAncestorContainer)) ultimoRange.current = r.cloneRange();
    };

    // Sem dependências: `lembrarSelecao` só lê refs, e reassinar o ouvinte a cada
    // render trocaria o listener no meio de uma seleção em andamento.
    useEffect(() => {
      document.addEventListener('selectionchange', lembrarSelecao);
      return () => document.removeEventListener('selectionchange', lembrarSelecao);
    }, []);

    const emitir = (): void => {
      const el = caixa.current;
      if (!el) return;
      const texto = serializar(el);
      meuTexto.current = texto;
      onChange(texto);
    };

    /*
     * 🔒 SÓ RECONSTRÓI QUANDO O TEXTO VEIO DE FORA. Digitar já muda o DOM: se o
     * efeito reescrevesse o conteúdo a cada tecla, o cursor voltaria para o fim
     * a cada letra. `meuTexto` guarda o que o próprio editor emitiu; se o valor
     * que chega é esse, não há nada a fazer. Reconstrói quando o texto veio de
     * outro lugar — trocar de aba, abrir um rascunho, copiar para traduzir.
     */
    useEffect(() => {
      const el = caixa.current;
      if (!el || valor === meuTexto.current) return;
      el.replaceChildren(fragmentoDe(valor));
      meuTexto.current = valor;
      // `fragmentoDe` depende de `t` e de `variaveis`, que são estáveis na
      // prática; incluí-los faria o editor se reconstruir e perder o cursor.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [valor]);

    const inserirNoCursor = (texto: string): void => {
      const el = caixa.current;
      if (!el) return;
      /*
       * A ordem importa: lê a seleção ANTES de `focus()`, porque focar pode
       * recolhê-la para o começo — foi assim que a variável ia parar antes do
       * "¡Hola". Se a seleção viva não está no editor (o clique no botão a
       * tirou de lá), vale a última que estava; e só então o fim do texto.
       */
      const sel = window.getSelection();
      /*
       * 🔒 SÓ VALE A SELEÇÃO VIVA SE O EDITOR ESTÁ COM O FOCO. Clicar num botão
       * da barra passa o foco para o botão, e a seleção que sobra dentro do
       * editor pode ser uma sobra recolhida no começo — foi ela que jogava
       * `{{worker_name}}` para antes do "¡Hola". Sem foco, quem manda é a
       * última posição lembrada.
       */
      const viva = document.activeElement === el && sel && sel.rangeCount > 0
        ? sel.getRangeAt(0)
        : null;
      let range: Range;
      if (viva && el.contains(viva.commonAncestorContainer)) {
        range = viva;
      } else if (ultimoRange.current && el.contains(ultimoRange.current.commonAncestorContainer)) {
        range = ultimoRange.current;
      } else {
        /*
         * ⚠️ Sem seleção nenhuma, insere NO FIM. É o caso de quem clica no
         * botão de variável antes de clicar no texto; jogar para o começo faria
         * a variável aparecer antes do "¡Hola".
         */
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
      }
      el.focus();
      range.deleteContents();
      const frag = fragmentoDe(texto);
      const ultimo = frag.lastChild;
      range.insertNode(frag);
      // O cursor fica DEPOIS do que foi inserido, para continuar escrevendo.
      if (ultimo && sel) {
        const depois = document.createRange();
        depois.setStartAfter(ultimo);
        depois.collapse(true);
        sel.removeAllRanges();
        sel.addRange(depois);
        ultimoRange.current = depois.cloneRange();
      }
      emitir();
    };

    useImperativeHandle(ref, () => ({ inserir: inserirNoCursor }));

    return (
      <div
        id={id}
        ref={caixa}
        role="textbox"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        onInput={() => { emitir(); lembrarSelecao(); }}
        onKeyUp={lembrarSelecao}
        onMouseUp={lembrarSelecao}
        /*
         * 🔒 QUEM DIGITA `{{worker_name}}` À MÃO TAMBÉM GANHA O CHIP — mas só ao
         * sair do campo. Fazer isso a cada tecla seria reescrever o DOM embaixo
         * do cursor no meio da palavra; no blur ninguém está escrevendo, e a
         * reconstrução é invisível. Sem isto o mesmo texto aparecia de dois
         * jeitos: cru enquanto digitado, chip depois de recarregar a página.
         */
        onBlur={() => {
          const el = caixa.current;
          if (!el) return;
          /*
           * 🔒 SÓ RECONSTRÓI SE HÁ TOKEN CRU DE VARIÁVEL CONHECIDA. Reconstruir
           * sempre custava caro e em silêncio: `replaceChildren` remove os
           * filhos, e um `Range` vivo apontando para depois deles é reajustado
           * para o COMEÇO — a variável inserida logo em seguida ia parar antes
           * do texto ("{{worker_name}}¡Hola" em vez de "¡Hola {{worker_name}}").
           * Medido em teste isolado; não é teoria de cascata.
           */
          const visivel = el.textContent ?? '';
          if (!variaveis.some((v) => visivel.includes(`{{${v}}}`))) return;
          const texto = serializar(el);
          el.replaceChildren(fragmentoDe(texto));
          meuTexto.current = texto;
          // O DOM mudou por baixo: a posição lembrada não aponta mais para nada
          // confiável, e o próximo `inserir` deve ir para o fim, não para o
          // lugar que essa posição virou depois do reajuste.
          ultimoRange.current = null;
        }}
        /*
         * 🔒 COLAR ENTRA COMO TEXTO PURO. Sem isto, colar de um documento traz
         * `<span style=...>`, `<font>` e tabelas inteiras para dentro do corpo
         * — e a serialização mandaria à Meta um texto com espaços e quebras que
         * ninguém digitou. O `{{...}}` colado vira chip pelo mesmo caminho de
         * sempre, então colar a mensagem antiga continua funcionando.
         */
        onPaste={(e) => {
          e.preventDefault();
          inserirNoCursor(e.clipboardData.getData('text/plain'));
        }}
        /* O texto de exemplo some ao primeiro caractere — `:empty` em CSS, não
           um nó no DOM, porque um nó apareceria no `serializar` e viraria corpo
           da mensagem. */
        data-vazio={t('admin.templateDrafts.campo.bodyPlaceholder')}
        className="min-h-[132px] w-full rounded-b-[10px] border border-gray-600 bg-white px-[13px] py-[12px] text-[13px] leading-[1.62] text-primary outline-none empty:before:text-gray-800 empty:before:content-[attr(data-vazio)] focus:border-primary"
        {...resto}
      />
    );
  },
);
