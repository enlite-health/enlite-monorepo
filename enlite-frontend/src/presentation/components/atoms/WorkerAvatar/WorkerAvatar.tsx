interface WorkerAvatarProps {
  name: string | null;
  avatarUrl: string | null;
  size?: number;
  className?: string;
}

function getInitials(name: string | null): string {
  if (!name) return '?';
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export function WorkerAvatar({
  name,
  avatarUrl,
  size = 32,
  className = '',
}: WorkerAvatarProps): JSX.Element {
  const sizeStyle = { width: size, height: size };

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name ?? 'worker avatar'}
        style={sizeStyle}
        className={`rounded-full object-cover flex-shrink-0 ${className}`}
      />
    );
  }

  return (
    <div
      aria-label={name ?? 'worker avatar'}
      style={sizeStyle}
      className={`rounded-full bg-primary text-white flex items-center justify-center flex-shrink-0 font-lexend font-semibold text-xs ${className}`}
    >
      {getInitials(name)}
    </div>
  );
}
