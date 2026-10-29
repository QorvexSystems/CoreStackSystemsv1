'use client';

import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { Camera, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

type BarcodeCameraScannerProps = {
  onDetected: (value: string) => void;
  label?: string;
};

export function BarcodeCameraScanner({
  onDetected,
  label = 'Escanear con camara',
}: BarcodeCameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => () => stopScanner(), []);

  async function startScanner() {
    if (!videoRef.current) {
      return;
    }

    try {
      setScanning(true);
      const reader = new BrowserMultiFormatReader();
      controlsRef.current = await reader.decodeFromVideoDevice(
        undefined,
        videoRef.current,
        (result) => {
          const text = result?.getText();

          if (!text) {
            return;
          }

          onDetected(text);
          toast.success('Codigo detectado', { description: text });
          stopScanner();
        },
      );
    } catch {
      setScanning(false);
      toast.error('No se pudo activar la camara.', {
        description: 'Puedes usar una pistola USB o escribir el codigo manualmente.',
      });
    }
  }

  function stopScanner() {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setScanning(false);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={startScanner} disabled={scanning}>
          <Camera className="h-4 w-4" />
          {label}
        </Button>
        {scanning ? (
          <Button type="button" variant="ghost" onClick={stopScanner}>
            <X className="h-4 w-4" />
            Detener
          </Button>
        ) : null}
      </div>
      <video
        ref={videoRef}
        className={scanning ? 'aspect-video w-full rounded-md bg-black object-cover' : 'hidden'}
        muted
      />
    </div>
  );
}
