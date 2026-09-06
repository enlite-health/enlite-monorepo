import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { Heading, Label, Text } from '@presentation/components/atoms';

interface CampoEditavelProps {
  id: string;
  label: string;
  /**
   * `titulo` (pedido do Gabriel, 05/09, 2ª rodada): o valor É o título da seção
   * e o lápis fica AO LADO dele — sem a legenda "Nombre" em cima, que repetia o
   * que o título já dizia. A legenda continua existindo para o leitor de tela
   * (`sr-only`) e para o `getByLabelText` do input quando aberto.
   */
  variant?: 'campo' | 'titulo';
  /** `titulo`: id do `<span>` do valor, para o `aria-labelledby` da seção. */
  valueId?: string;
  /** `titulo`: o que vai depois do nome (" · Sistema", " · Archivado"). */
  sufixo?: ReactNode;
  /** O valor salvo. `null`/`''` vira travessão. */
  value: string | null;
  /** `false` → nunca vira input; nem o lápis aparece. */
  editable: boolean;
  /** O input/textarea que aparece ao abrir. Recebe o `id` de fora. */
  children: ReactNode;
  /**
   * Confirma. Devolver `false` MANTÉM o campo aberto — é como o chamador diz
   * "o servidor recusou". O contrato antes prometia isso e o tipo não sabia
   * expressar (`void | Promise<void>`), então nunca era lido: um save que
   * falhava fechava o campo e deixava o rascunho recusado no formulário.
   */
  onConfirm: () => boolean | Promise<boolean>;
  /** Descarta o rascunho e fecha. */
  onCancel: () => void;
}

/**
 * Texto com um lápis ao lado; o input só existe depois do clique.
 *
 * Pedido do Gabriel (05/09): a tela do grupo abria com tudo em campo de
 * formulário, e um input sempre aberto convida a digitar onde ninguém queria
 * mudar nada — além de ocupar o dobro da altura para mostrar a mesma coisa.
 *
 * O `ReadOnlyField` vizinho resolve outro problema: ele decide entre texto e
 * input pela POSTURA (quem não pode escrever nunca vê input). Este decide pela
 * INTENÇÃO de quem pode. Os dois convivem: sem `editable` aqui, nem o lápis sai.
 *
 * Esc cancela e Enter confirma — quem abriu com o teclado precisa sair por ele.
 * `Enter` só vale em campo de uma linha: em textarea ele é quebra de linha, e
 * roubá-lo tornaria a descrição de várias linhas impossível de escrever.
 */
export function CampoEditavel({
  id, label, value, editable, children, onConfirm, onCancel, variant = 'campo', valueId, sufixo,
}: CampoEditavelProps): JSX.Element {
  const titulo = variant === 'titulo';
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(false);
  const caixa = useRef<HTMLDivElement>(null);

  // O foco vai para o campo ao abrir: sem isso o clique no lápis deixa o teclado
  // parado num botão que sumiu, e quem usa leitor de tela não sabe que abriu.
  // Procurar o campo dentro do container evita um `ref` tipado para input E
  // textarea ao mesmo tempo, que é ginástica de tipo sem ganho.
  useEffect(() => {
    if (aberto) caixa.current?.querySelector<HTMLElement>('input, textarea')?.focus();
  }, [aberto]);

  const fechar = (): void => { setAberto(false); onCancel(); };
  const confirmar = async (): Promise<void> => {
    if (await onConfirm()) setAberto(false);
  };

  const lapis = editable && (
    <button
      type="button"
      onClick={() => setAberto(true)}
      aria-label={t('admin.access.group.editField', { campo: label })}
      data-testid={`${id}-editar`}
      className="text-primary hover:text-primary/70 transition-colors p-1 rounded focus:outline-none focus:ring-2 focus:ring-primary"
    >
      <Pencil className={titulo ? 'w-5 h-5' : 'w-4 h-4'} strokeWidth={2} />
    </button>
  );

  if (titulo && (!editable || !aberto)) {
    return (
      <div className="flex items-center gap-2" data-testid={`${id}-readonly`}>
        <Heading level={2} weight="semibold" color="primary">
          <span id={valueId}>{value === null || value === '' ? '—' : value}</span>
          {sufixo}
        </Heading>
        {lapis}
      </div>
    );
  }

  if (!editable || !aberto) {
    return (
      <div>
        <div className="flex items-center gap-2">
          <Label htmlFor={undefined}>{label}</Label>
          {lapis}
        </div>
        <div className="px-3 py-2 min-h-[40px] flex items-center" data-testid={`${id}-readonly`}>
          <Text as="span" size="sm" color="primary" className="whitespace-pre-line">
            {value === null || value === '' ? '—' : value}
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={caixa}
      onKeyDown={(e) => {
        if (e.key === 'Escape') fechar();
        // Enter confirma só quando o foco está no CAMPO de uma linha.
        // Era `!== 'TEXTAREA'`, e um BUTTON passa nesse teste: quem tabulava até
        // Cancelar e apertava Enter SALVAVA o rascunho que queria descartar —
        // o `preventDefault` ainda suprimia a ativação nativa do botão.
        // (achado do gate, 05/09). No textarea o Enter é quebra de linha.
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
          e.preventDefault();
          void confirmar();
        }
      }}
    >
      <Label htmlFor={id} className={titulo ? 'sr-only' : ''}>{label}</Label>
      <div className="max-w-xl">{children}</div>
      <div className="flex gap-2 pt-2">
        <button
          type="button"
          onClick={() => void confirmar()}
          data-testid={`${id}-confirmar`}
          className="rounded-full bg-primary text-white px-4 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <Text as="span" size="xs" color="inherit">{t('admin.access.group.save')}</Text>
        </button>
        <button
          type="button"
          onClick={fechar}
          data-testid={`${id}-cancelar`}
          className="rounded-full border border-gray-300 px-4 py-1.5 hover:border-gray-500 focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <Text as="span" size="xs" color="secondary">{t('admin.access.groups.cancel')}</Text>
        </button>
      </div>
    </div>
  );
}
