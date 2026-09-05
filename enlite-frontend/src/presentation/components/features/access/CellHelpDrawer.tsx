import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading, Text } from '@presentation/components/atoms';

interface CellHelpDrawerProps {
  /** O recurso aberto — `null` fecha o painel. */
  resource: string | null;
  /** O rótulo visível do recurso, o mesmo que a linha mostra. */
  rotulo: string;
  /** As ações que ESTE recurso tem, na ordem em que a grade as desenha. */
  acoes: readonly string[];
  onClose: () => void;
}

/**
 * O painel lateral de ajuda de uma permissão.
 *
 * Por que um painel e não um tooltip: o texto é longo de propósito. Quem
 * concede precisa saber o que a pessoa passa a VER, o que continua sem ver, e
 * o que cada caixa da linha faz — isso não cabe num balão que some.
 *
 * O texto vive em `admin.access.group.cells.help.resource.<recurso>` e é
 * ESCRITO por nós, não vem do catálogo: as descrições do seed estão erradas de
 * um jeito que faz conceder errado (`worker:export` diz "exportar listagem" e
 * entrega o dossiê descriptografado). Recurso sem texto curado diz que não tem
 * texto, em vez de inventar um — o catálogo cresce sem passar por aqui.
 *
 * O parecer do `lex` (05/09) condicionou este texto a duas coisas, e elas estão
 * no conteúdo, não neste componente: não prometer registro que não acontece; e
 * não descrever efeito de célula que nenhuma rota exige (`worker:delete` diz que
 * não faz nada hoje).
 *
 * ⚠️ O parecer RECOMENDAVA uma terceira — nomear as categorias sensíveis — e o
 * Gabriel decidiu o contrário em 05/09: "não tem por que colocar essas coisas de
 * religião no popup". O texto avisa do peso ("datos que la ley protege de forma
 * especial") sem listar, e há teste que fica VERMELHO se a enumeração voltar.
 * Não reescreva o texto seguindo o parecer sem falar com ele.
 */
export function CellHelpDrawer({ resource, rotulo, acoes, onClose }: CellHelpDrawerProps): JSX.Element | null {
  const { t } = useTranslation();
  const fechar = useRef<HTMLButtonElement>(null);

  // Esc fecha, e o foco vai para o botão de fechar ao abrir: sem isso o teclado
  // continua no `?` atrás do painel, e o leitor de tela não anuncia nada.
  useEffect(() => {
    if (!resource) return undefined;
    fechar.current?.focus();
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [resource, onClose]);

  if (!resource) return null;

  const base = `admin.access.group.cells.help.resource.${resource}`;
  const corpo = t(`${base}.body`, '');
  const temTexto = corpo !== '' && corpo !== `${base}.body`;

  return (
    <>
      {/* A cortina fecha ao clique do MOUSE e some da árvore de acessibilidade:
          um segundo botão chamado "Cerrar" só duplicaria a parada de tabulação
          com o mesmo nome do primeiro, que é ruído, não acesso. Para o teclado o
          caminho é o botão Cerrar e o Esc — os dois existem. */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-40 bg-black/20"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={rotulo}
        data-testid="cell-help"
        className="fixed right-0 top-0 z-50 h-full w-full max-w-md overflow-y-auto bg-white shadow-xl border-l border-gray-300 p-5 space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <Heading level={3} weight="semibold" color="primary">{rotulo}</Heading>
            <Text as="span" size="xs" color="secondary" className="block font-mono">{resource}</Text>
          </div>
          <button
            ref={fechar}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded px-2 py-1 border border-gray-300 hover:border-gray-500 focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <Text as="span" size="xs" color="secondary">{t('admin.access.group.cells.help.close')}</Text>
          </button>
        </div>

        {temTexto ? (
          <>
            <Text size="sm" color="primary">{corpo}</Text>
            <div className="space-y-2 pt-2 border-t border-gray-200">
              <Text as="span" size="xs" weight="medium" color="secondary" className="block">
                {t('admin.access.group.cells.help.actions')}
              </Text>
              {acoes.map((acao) => {
                const texto = t(`${base}.action.${acao}`, '');
                if (texto === '' || texto === `${base}.action.${acao}`) return null;
                return (
                  <div key={acao} className="space-y-0.5">
                    <Text as="span" size="xs" weight="medium" color="primary" className="block">
                      {t(`admin.access.group.cells.action.${acao}`, acao)}
                    </Text>
                    <Text as="span" size="xs" color="secondary" className="block">{texto}</Text>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <Text size="sm" color="secondary">{t('admin.access.group.cells.help.missing')}</Text>
        )}
      </aside>
    </>
  );
}
