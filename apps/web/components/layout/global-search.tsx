'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import type { AuthSession } from '@/lib/auth-session';

export function GlobalSearch({ mobile = false }: { session: AuthSession; mobile?: boolean }) {
  const router = useRouter();
  const [query, setQuery] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    router.push(query.trim() ? `/reservations?q=${encodeURIComponent(query.trim())}` : '/reservations');
  }

  return (
    <form onSubmit={submit} className={mobile ? 'relative w-full' : 'relative hidden w-full max-w-[32rem] md:block'}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-4 text-sm text-slate-800 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-teal focus:ring-2 focus:ring-teal/15"
        placeholder="Buscar reservación, huésped, habitación o canal..."
        aria-label="Buscar en Hotel Ancla"
      />
    </form>
  );
}
