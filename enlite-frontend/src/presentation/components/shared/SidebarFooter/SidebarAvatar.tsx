import { useState } from 'react';
import { Text } from '@presentation/components/atoms';

interface SidebarAvatarProps {
  /** Iniciais já resolvidas por quem chama (cada consumidor decide a regra). */
  initials: string;
  photoUrl?: string;
  /** Classes de tamanho do círculo (`w-8 h-8`, `w-10 h-10`). */
  sizeClass: string;
  /** Bolinha verde de "online" no canto — só o rodapé expandido tem. */
  showStatus?: boolean;
}

/**
 * Avatar da sidebar: foto se houver, senão as iniciais. Foto que falha ao carregar (URL expirada, bloqueio) cai nas
 * iniciais, nunca num ícone de imagem quebrada. `alt` vazio: o nome já está ao lado (ou no `aria-label` do link).
 */
export function SidebarAvatar({ initials, photoUrl, sizeClass, showStatus = false }: SidebarAvatarProps): JSX.Element {
  const [photoFailed, setPhotoFailed] = useState(false);
  return (
    <div className={`relative ${sizeClass} flex-shrink-0`}>
      {photoUrl && !photoFailed ? (
        <img
          src={photoUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setPhotoFailed(true)}
          className="w-full h-full rounded-full object-cover"
        />
      ) : (
        <div className="w-full h-full rounded-full bg-gray-300 flex items-center justify-center">
          <Text as="span" size="xs" weight="semibold" color="secondary" className="leading-none">
            {initials}
          </Text>
        </div>
      )}
      {showStatus && <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-white rounded-full" />}
    </div>
  );
}
