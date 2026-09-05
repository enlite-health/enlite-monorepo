import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, Input } from '@presentation/components/atoms';
import { Button } from '@presentation/components/atoms/Button';
import { ActionButton } from './ActionButton';

/** Uma pessoa na transferência — o mínimo para identificar quem recebe acesso. */
export interface TransferPerson {
  userId: string;
  name: string | null;
  email: string;
}

interface MemberTransferProps {
  /** A célula que autoriza mexer aqui — gateia as setas e o Guardar. */
  resource: string;
  /** Quem está no grupo HOJE (o estado salvo). */
  memberIds: readonly string[];
  /** Todo o staff, membros incluídos. */
  people: readonly TransferPerson[];
  /** `false` → só a lista de membros, sem colunas nem setas. */
  editable: boolean;
  /**
   * Quem não pode sair do grupo. Hoje chega vazio: o anti-lockout do último
   * `permission_management:write` vive no banco e a API de membros não expõe
   * as células de cada pessoa. A trava existe aqui para quando expuser — até
   * lá quem recusa é o backend, com `last_manager`.
   */
  lockedIds?: ReadonlySet<string>;
  onSave: (add: string[], remove: string[]) => Promise<void>;
}

const byName = (a: TransferPerson, b: TransferPerson): number =>
  (a.name ?? a.email).localeCompare(b.name ?? b.email, 'es-AR');

/**
 * A seção de membros: duas colunas, `Miembros` e `Resto del equipo`, com
 * multi-seleção e setas. O grupo é o assunto — o card mostra nome e e-mail, e
 * nada mais: papel, status e outros grupos são fatos da PESSOA e moram na tela
 * dela (decisão do Gabriel, 04/09).
 *
 * Mover é pendente: a coluna já é o estado, sem etiqueta de "entra"/"sai"
 * colada em ninguém, e nada vale até `Guardar`. Sem campo de motivo — a
 * filiação já é auditável por si (`assigned_at`/`removed_by`, mig 275); pede
 * motivo o que muda o SIGNIFICADO do grupo (as células), não a lotação.
 */
export function MemberTransfer({
  resource,
  memberIds,
  people,
  editable,
  lockedIds,
  onSave,
}: MemberTransferProps): JSX.Element {
  const { t } = useTranslation();

  const saved = useMemo(() => new Set(memberIds), [memberIds]);
  const [inside, setInside] = useState<Set<string>>(() => new Set(memberIds));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [side, setSide] = useState<'in' | 'out' | null>(null);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);

  const termo = filter.trim().toLowerCase();
  const { membros, resto } = useMemo(() => {
    const dentro: TransferPerson[] = [];
    const fora: TransferPerson[] = [];
    for (const p of people) (inside.has(p.userId) ? dentro : fora).push(p);
    const casa = (p: TransferPerson): boolean =>
      !termo || (p.name ?? '').toLowerCase().includes(termo) || p.email.toLowerCase().includes(termo);
    return { membros: dentro.sort(byName).filter(casa), resto: fora.sort(byName).filter(casa) };
  }, [people, inside, termo]);

  // Só um lado por vez tem seleção: com os dois, as duas setas ficariam ativas
  // e nenhuma diria o que faz.
  const alternar = (userId: string, lado: 'in' | 'out'): void => {
    // Deriva fora do updater: `setSide` dentro de `setPicked` seria efeito
    // colateral em função de atualização — React avisa, e em StrictMode roda
    // duas vezes.
    const proximo = new Set(lado === side ? picked : []);
    if (proximo.has(userId)) proximo.delete(userId);
    else proximo.add(userId);
    setPicked(proximo);
    setSide(proximo.size === 0 ? null : lado);
  };

  const mover = (destino: 'in' | 'out'): void => {
    setInside((antes) => {
      const proximo = new Set(antes);
      for (const uid of picked) {
        if (destino === 'in') proximo.add(uid);
        else if (!lockedIds?.has(uid)) proximo.delete(uid);
      }
      return proximo;
    });
    setPicked(new Set());
    setSide(null);
  };

  const add = [...inside].filter((uid) => !saved.has(uid));
  const remove = [...saved].filter((uid) => !inside.has(uid));
  const sujo = add.length > 0 || remove.length > 0;

  const cancelar = (): void => {
    setInside(new Set(memberIds));
    setPicked(new Set());
    setSide(null);
  };

  const salvar = async (): Promise<void> => {
    setSaving(true);
    try {
      // Adiciona ANTES de remover: trocar o último gestor por outro só passa
      // pelo anti-lockout do banco nessa ordem.
      await onSave(add, remove);
      setPicked(new Set());
      setSide(null);
    } finally {
      setSaving(false);
    }
  };

  if (!editable) {
    return (
      <div className="space-y-2" data-testid="members-readonly">
        <ColumnHead label={t('admin.access.group.membersTitle')} total={membros.length} />
        <ul className="space-y-1" data-clarity-mask="True">
          {membros.map((p) => (
            <li key={p.userId}>
              <PersonCard person={p} />
            </li>
          ))}
        </ul>
        {membros.length === 0 && (
          <Text size="sm" color="secondary">{t('admin.access.group.noMembers')}</Text>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="member-transfer">
      {/* o filtro é acessório da lista, não um campo de formulário: `compact`
          e contido, para não pesar mais que as duas colunas que ele filtra */}
      <Input
        inputSize="compact"
        className="max-w-sm"
        aria-label={t('admin.access.group.transfer.filter')}
        placeholder={t('admin.access.group.transfer.filter')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {/* `Resto del equipo` à ESQUERDA e `Miembros` à DIREITA (pedido do Gabriel,
          05/09). A direção das setas continua literal: → empurra da esquerda
          para a direita, que agora é ENTRAR no grupo; ← devolve ao resto. Antes,
          com as colunas trocadas, a seta apontava para o lado contrário do
          movimento que ela fazia. */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-stretch" data-clarity-mask="True">
        <Column
          label={t('admin.access.group.transfer.rest')}
          people={resto}
          picked={picked}
          active={side === 'out'}
          emptyKey="admin.access.group.transfer.allInside"
          onToggle={(uid) => alternar(uid, 'out')}
        />

        {/* As setas no MEIO da altura das colunas, não no topo: elas agem sobre
            as duas listas inteiras, e ancoradas no cabeçalho pareciam pertencer
            a ele. `self-center` centra só este bloco — as colunas seguem
            alinhadas pelo topo uma com a outra. */}
        <div className="flex flex-col gap-2 self-center">
          <ActionButton
            resource={resource}
            size="sm"
            variant="outline"
            aria-label={t('admin.access.group.transfer.toMembers')}
            disabled={side !== 'out'}
            onClick={() => mover('in')}
          >
            →
          </ActionButton>
          <ActionButton
            resource={resource}
            size="sm"
            variant="outline"
            aria-label={t('admin.access.group.transfer.toRest')}
            disabled={side !== 'in'}
            onClick={() => mover('out')}
          >
            ←
          </ActionButton>
        </div>

        <Column
          label={t('admin.access.group.membersTitle')}
          people={membros}
          picked={picked}
          active={side === 'in'}
          lockedIds={lockedIds}
          emptyKey="admin.access.group.noMembers"
          onToggle={(uid) => alternar(uid, 'in')}
        />
      </div>

      {sujo && (
        <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-200">
          <Text as="span" size="xs" color="secondary" className="mr-auto">
            {t('admin.access.group.transfer.unsaved')}
          </Text>
          <Button variant="ghost" size="sm" onClick={cancelar} disabled={saving}>
            {t('admin.access.groups.cancel')}
          </Button>
          <ActionButton
            resource={resource}
            variant="primary"
            size="sm"
            isLoading={saving}
            onClick={() => void salvar()}
          >
            {t('admin.access.group.save')}
          </ActionButton>
        </div>
      )}
    </div>
  );
}

function ColumnHead({
  label,
  total,
  selected,
}: {
  label: string;
  total: number;
  selected?: number;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between pb-1 border-b border-gray-200">
      <Text as="span" size="xs" weight="medium" color="secondary">{label}</Text>
      <Text as="span" size="xs" weight="medium" color={selected ? 'primary' : 'secondary'}>
        {selected === undefined ? total : `${selected} / ${total}`}
      </Text>
    </div>
  );
}

interface ColumnProps {
  label: string;
  people: TransferPerson[];
  picked: Set<string>;
  active: boolean;
  lockedIds?: ReadonlySet<string>;
  emptyKey: string;
  onToggle: (userId: string) => void;
}

function Column({ label, people, picked, active, lockedIds, emptyKey, onToggle }: ColumnProps): JSX.Element {
  const { t } = useTranslation();
  const marcados = active ? people.filter((p) => picked.has(p.userId)).length : 0;

  return (
    <div className="min-w-0 space-y-1">
      <ColumnHead label={label} total={people.length} selected={marcados} />
      <ul
        className="bg-gray-50 rounded-xl p-1.5 space-y-1 min-h-[9rem] max-h-80 overflow-y-auto"
        role="listbox"
        aria-multiselectable="true"
        aria-label={label}
      >
        {people.map((p) => {
          const travada = lockedIds?.has(p.userId) ?? false;
          const marcada = picked.has(p.userId);
          return (
            <li key={p.userId}>
              <button
                type="button"
                role="option"
                aria-selected={marcada}
                disabled={travada}
                title={travada ? t('admin.access.group.transfer.locked') : undefined}
                onClick={() => onToggle(p.userId)}
                className={[
                  'w-full text-left rounded-lg border px-2.5 py-1.5 bg-white transition-colors',
                  marcada ? 'border-primary ring-1 ring-primary' : 'border-gray-200 hover:border-gray-400',
                  travada ? 'opacity-60 cursor-not-allowed' : '',
                ].filter(Boolean).join(' ')}
              >
                <PersonCard person={p} locked={travada} />
              </button>
            </li>
          );
        })}
        {people.length === 0 && (
          <li className="px-2.5 py-3">
            <Text as="span" size="xs" color="secondary">{t(emptyKey)}</Text>
          </li>
        )}
      </ul>
    </div>
  );
}

function PersonCard({ person, locked = false }: { person: TransferPerson; locked?: boolean }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="min-w-0">
        <Text as="span" size="xs" weight="medium" color="primary" className="block truncate">
          {person.name ?? person.email}
        </Text>
        {person.name && (
          <Text as="span" size="xs" color="secondary" className="block truncate">
            {person.email}
          </Text>
        )}
      </div>
      {locked && (
        <span className="ml-auto shrink-0" aria-label={t('admin.access.group.transfer.locked')}>
          <Text as="span" size="xs" color="secondary">🔒</Text>
        </span>
      )}
    </div>
  );
}
