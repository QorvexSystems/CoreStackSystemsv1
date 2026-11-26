import { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type PlaceholderPageProps = {
  title: string;
  description: string;
  icon: LucideIcon;
  items: string[];
};

export function PlaceholderPage({ title, description, icon: Icon, items }: PlaceholderPageProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-accent">Modulo operativo</p>
          <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-md bg-accent/12 text-accent">
          <Icon className="h-6 w-6" />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {items.map((item) => (
          <Card key={item}>
            <CardHeader>
              <CardTitle>{item}</CardTitle>
              <CardDescription>Preparado para implementacion incremental con contexto tenant.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-2 rounded-sm bg-muted" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
