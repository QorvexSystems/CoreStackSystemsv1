import { brand } from '@/lib/brand';

export function ModuleHeader({
  eyebrow = brand.name,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gold-deep">{eyebrow}</p>
      <h1 className="text-3xl font-semibold leading-none text-foreground sm:text-4xl">{title}</h1>
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  );
}
