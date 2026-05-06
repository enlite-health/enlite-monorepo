import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading, Text } from '@presentation/components/atoms';
import { Button } from '@presentation/components/atoms/Button';

interface Props {
  email: string;
  resetLink: string;
  mode?: 'create' | 'reset';
  onClose: () => void;
}

export function InvitationFallbackModal({ email, resetLink, mode = 'create', onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(resetLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // clipboard not available — silently fail
    }
  };

  const title = mode === 'reset'
    ? t('admin.users.resetLinkSentTitle')
    : t('admin.users.invitationFallbackTitle');

  const description = mode === 'reset'
    ? t('admin.users.resetLinkSentDesc', { email })
    : (
      <>
        <Text as="p" size="sm" color="secondary" className="mb-1">
          {t('admin.users.invitationSent', { email })}
        </Text>
        <Text as="p" size="sm" color="secondary" className="mb-4">
          {t('admin.users.invitationFallbackDesc')}
        </Text>
      </>
    );

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-lg shadow-lg">
        <Heading level={2} weight="semibold" color="primary" className="mb-2">
          {title}
        </Heading>

        {mode === 'reset' ? (
          <Text as="p" size="sm" color="secondary" className="mb-4">
            {description as string}
          </Text>
        ) : (
          description
        )}

        <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 mb-4 break-all">
          <Text as="p" size="xs" color="secondary">
            {resetLink}
          </Text>
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
            onClick={onClose}
          >
            {t('admin.users.done')}
          </button>
          <Button variant="primary" onClick={handleCopy}>
            {copied ? t('admin.users.linkCopied') : t('admin.users.copyLink')}
          </Button>
        </div>
      </div>
    </div>
  );
}
