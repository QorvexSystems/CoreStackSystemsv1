'use client';

import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react';
import { ActionDialog } from '@/components/ui/action-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function AppointmentDateTimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [month, setMonth] = useState(value.slice(0, 7));
  const [day, time = '09:00'] = draft.split('T');
  const anchor = new Date(`${month || value.slice(0,7)}-01T12:00:00`);
  const offset = (anchor.getDay() + 6) % 7;
  const days = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  const label = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const shiftMonth = (direction: number) => {
    const next = new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1, 12);
    setMonth(`${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}`);
  };
  return <>
    <Button type="button" variant="outline" className="h-auto min-h-14 w-full justify-start gap-3 px-4 py-3 text-left" aria-haspopup="dialog" onClick={() => { setDraft(value); setMonth(value.slice(0,7)); setOpen(true); }}>
      <CalendarDays className="h-5 w-5 shrink-0" />
      <span className="min-w-0 whitespace-normal"><span className="block capitalize">{value ? label(value.slice(0,10)) : 'Seleccionar fecha'}</span><span className="mt-1 block text-sm text-muted-foreground">{value ? new Date(value).toLocaleTimeString('es-DO', {hour:'numeric',minute:'2-digit',hour12:true}) : 'Seleccionar hora'}</span></span>
    </Button>
    <ActionDialog open={open} size="lg" title="Fecha y hora de la cita" description="Elige el día en el calendario y la hora de llegada." confirmLabel="Usar fecha y hora" cancelLabel="Cancelar" confirmDisabled={!day || !time} onClose={() => setOpen(false)} onConfirm={() => { onChange(`${day}T${time}`); setOpen(false); }}>
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div>
      <div className="flex items-center justify-between gap-3">
        <Button type="button" size="icon" variant="outline" aria-label="Mes anterior" onClick={() => shiftMonth(-1)}><ChevronLeft className="h-5 w-5" /></Button>
        <p aria-live="polite" className="text-base font-semibold capitalize">{anchor.toLocaleDateString('es-DO',{month:'long',year:'numeric'})}</p>
        <Button type="button" size="icon" variant="outline" aria-label="Mes siguiente" onClick={() => shiftMonth(1)}><ChevronRight className="h-5 w-5" /></Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(name => <span key={name} className="py-2 text-xs font-semibold text-muted-foreground">{name}</span>)}
        {Array.from({length:offset},(_,index)=><span key={`empty-${index}`} />)}
        {Array.from({length:days},(_,index)=>{
          const date=`${month}-${String(index+1).padStart(2,'0')}`;
          return <button type="button" key={date} aria-label={label(date)} aria-pressed={day===date} className={`min-h-11 rounded-lg border text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${day===date?'border-primary bg-primary text-primary-foreground':'border-transparent hover:bg-muted'}`} onClick={() => setDraft(`${date}T${time}`)}>{index+1}</button>;
        })}
      </div>
      </div>
      <div className="space-y-3 border-t pt-4 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
        <label className="grid gap-2 text-sm font-semibold"><span className="flex items-center gap-2"><Clock3 className="h-4 w-4" />Hora de llegada</span><Input type="time" aria-label="Hora de llegada" className="h-12 text-lg" value={time} onChange={event => setDraft(`${day}T${event.target.value}`)} /></label>
        <div className="grid grid-cols-2 gap-2">{['09:00','10:00','11:00','14:00','15:00','16:00'].map(hour=><Button key={hour} type="button" variant={time===hour?'default':'outline'} className="h-11 px-2 text-xs" onClick={()=>setDraft(`${day}T${hour}`)}>{Number(hour.slice(0,2))%12||12}:00 {Number(hour.slice(0,2))<12?'a. m.':'p. m.'}</Button>)}</div>
        <p className="text-sm font-medium capitalize">{day ? label(day) : ''} · {time}</p>
      </div>
      </div>
    </ActionDialog>
  </>;
}
