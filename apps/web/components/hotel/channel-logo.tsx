import { Building2, Globe2 } from 'lucide-react';
import type { ComponentType } from 'react';
import { SiAirbnb, SiBookingdotcom, SiExpedia, SiWhatsapp } from 'react-icons/si';

type ChannelIcon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

const channelVisuals: Record<string, { icon: ChannelIcon; tone: string }> = {
  'Directo (Web)': { icon: Globe2, tone: 'bg-teal-light text-teal-deep' },
  'Sitio Web': { icon: Globe2, tone: 'bg-teal-light text-teal-deep' },
  Interno: { icon: Building2, tone: 'bg-slate-100 text-slate-700' },
  WhatsApp: { icon: SiWhatsapp, tone: 'bg-emerald-50 text-[#20b858]' },
  'Booking.com': { icon: SiBookingdotcom, tone: 'bg-blue-50 text-[#003b95]' },
  Expedia: { icon: SiExpedia, tone: 'bg-amber-50 text-[#e99d00]' },
  Airbnb: { icon: SiAirbnb, tone: 'bg-rose-50 text-[#ff385c]' },
};

function getChannelVisual(name: string) {
  return channelVisuals[name] ?? { icon: Globe2, tone: 'bg-slate-100 text-slate-600' };
}

export function ChannelLogo({ name, size = 'sm' }: { name: string; size?: 'sm' | 'lg' }) {
  const visual = getChannelVisual(name);
  const Icon = visual.icon;
  const sizing = size === 'lg' ? 'h-12 w-12 rounded-xl' : 'h-6 w-6 rounded-md';
  const iconSizing = size === 'lg' ? 'h-6 w-6' : 'h-3.5 w-3.5';

  return (
    <span
      aria-label={`Canal ${name}`}
      className={`inline-flex shrink-0 items-center justify-center ${sizing} ${visual.tone}`}
      title={name}
    >
      <Icon aria-hidden className={iconSizing} />
    </span>
  );
}

export function ChannelBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-100 bg-white/80 py-0.5 pl-0.5 pr-2 font-medium shadow-sm">
      <ChannelLogo name={name} />
      <span>{name}</span>
    </span>
  );
}

export function ChannelLabel({ name }: { name: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ChannelLogo name={name} />
      <span className="truncate font-medium">{name}</span>
    </span>
  );
}
