import type { JSX } from 'preact';
import { Plus, Minus, LockKeyhole, KeyRound, ArrowRight, Hand, MousePointer2, Scan, Trash2, X, Check, Download, Upload, StickyNote, Sun, RotateCw, Waypoints, ImagePlus, Grip, Group, Ellipsis, Search, ChevronLeft, ChevronRight, Pin, PinOff, PanelsTopLeft, Share2, UserRound, LogOut } from 'lucide-preact';

export type IconName = 'plus' | 'minus' | 'lock' | 'key' | 'arrow' | 'hand' | 'cursor' | 'fit' | 'trash' | 'close' | 'check' | 'download' | 'upload' | 'note' | 'sun' | 'retry' | 'connect' | 'image' | 'grip' | 'group' | 'dashed' | 'search' | 'previous' | 'next' | 'pin' | 'unpin' | 'boards' | 'share' | 'user' | 'logout';
const icons = {
  plus: Plus, minus: Minus, lock: LockKeyhole, key: KeyRound,
  arrow: ArrowRight, hand: Hand, cursor: MousePointer2, fit: Scan,
  trash: Trash2, close: X, check: Check, download: Download,
  upload: Upload, note: StickyNote, sun: Sun, retry: RotateCw,
  connect: Waypoints, image: ImagePlus, grip: Grip, group: Group,
  dashed: Ellipsis,
  search: Search, previous: ChevronLeft, next: ChevronRight,
  pin: Pin, unpin: PinOff,
  boards: PanelsTopLeft, share: Share2, user: UserRound, logout: LogOut,
};
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const Component = icons[name];
  return <Component size={size} strokeWidth={1.6} aria-hidden="true" />;
}
export function Button({ children, icon, label, className = '', ...props }: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; label?: string }) {
  return <button type="button" {...props} className={`button ${className}`} aria-label={label} data-tooltip={label}>{icon && <Icon name={icon} />}{children}</button>;
}
