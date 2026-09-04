import { useTranslation } from 'react-i18next';
import { Button, type ButtonProps } from '@presentation/components/atoms/Button';
import { useActionGate } from '@presentation/hooks/useCellAccess';

/** Ações de célula que um `ActionButton` pode gatear. `write` é o default (a maioria dos botões de concluir edição). */
export type ActionButtonAction = 'write' | 'delete' | 'execute' | 'send' | 'disable';

/**
 * `hide` (default, D269 — correção do Gabriel: "desabilitar não, ESCONDER.
 * Não pode estar visível."): sem a célula, o botão SOME (`return null`).
 * `disable`: fica na árvore desabilitado, com `aria-disabled` e o motivo no
 * `title` — só quando o call site pedir explicitamente (nenhum lugar em
 * produção usa `disable` hoje).
 */
export type ActionButtonMode = 'hide' | 'disable';

interface ActionButtonProps extends ButtonProps {
  /** O recurso da célula (`recurso:ação`) que autoriza esta ação. */
  resource: string;
  /** A ação da célula. Default `'write'` — para `vacancy:delete`, `dedup:execute` etc. passe explicitamente. */
  action?: ActionButtonAction;
  mode?: ActionButtonMode;
}

/**
 * Um botão que CONCLUI edição (salvar, criar, arquivar, adicionar, remover,
 * ligar/desligar). A régua (D269, `mode='hide'` default): sem a célula o
 * botão SOME — não fica cinza, não fica com tooltip.
 *
 * Só gateia quando `authz.enforcement === 'on'` (mesmo freio de rollout de
 * `shouldShowWelcomeNoGroup`/`featureEnabledFor`, D268): com `'off'` ou
 * contrato ausente/ainda não carregado, o botão é um botão normal — senão a
 * `stage`, onde o engine está desligado e a maioria das contas não tem
 * grupo, ficaria com tudo sumido.
 */
export function ActionButton({
  resource,
  action = 'write',
  mode = 'hide',
  disabled,
  onClick,
  ...props
}: ActionButtonProps): JSX.Element | null {
  const { t } = useTranslation();
  const { allowed } = useActionGate(resource, action);

  if (allowed) {
    return <Button {...props} disabled={disabled} onClick={onClick} />;
  }

  if (mode === 'hide') return null;

  return (
    <Button
      {...props}
      disabled
      aria-disabled="true"
      title={t('access.actionDenied')}
      data-gate="denied"
      onClick={undefined}
    />
  );
}
