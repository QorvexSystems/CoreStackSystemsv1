import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold', {
  variants: {
    variant: {
      default: 'bg-muted text-foreground',
      success: 'bg-success/10 text-success',
      warning: 'bg-warning/10 text-gold-deep',
      danger: 'bg-danger/10 text-danger',
      info: 'bg-blue-50 text-blue-700',
      ready: 'bg-violet-50 text-violet-700',
      outline: 'border border-border bg-card',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}
