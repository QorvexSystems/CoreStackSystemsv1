'use client';

import { Barcode, Camera, Search, ScanLine, X } from 'lucide-react';
import { ChangeEvent, FormEvent, RefObject, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type BarcodeInputProps = {
  barcode: string;
  scannerEnabled: boolean;
  cameraActive: boolean;
  scannerMessage: string | null;
  barcodeInputRef: RefObject<HTMLInputElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  isPending: boolean;
  keepFocus?: boolean;
  showCamera?: boolean;
  onBarcodeChange: (value: string) => void;
  onSubmit: (code: string) => void;
  onEnableScanner: () => void;
  onDisableScanner: () => void;
  onStartCamera: () => void;
};

const autoSubmitMinLength = 6;
const autoSubmitLongCodeLength = 12;
const autoSubmitDelayMs = 220;

export function BarcodeInput({
  barcode,
  scannerEnabled,
  cameraActive,
  scannerMessage,
  barcodeInputRef,
  videoRef,
  isPending,
  keepFocus = false,
  showCamera = true,
  onBarcodeChange,
  onSubmit,
  onEnableScanner,
  onDisableScanner,
  onStartCamera,
}: BarcodeInputProps) {
  const lastSubmittedCodeRef = useRef('');

  useEffect(() => {
    const code = normalizeScannedCode(barcode);

    if (!code) {
      lastSubmittedCodeRef.current = '';
      return;
    }

    const canAutoSubmit =
      code.length >= autoSubmitLongCodeLength ||
      (scannerEnabled && code.length >= autoSubmitMinLength);

    if (!canAutoSubmit || cameraActive || isPending) {
      return;
    }

    const timeout = window.setTimeout(() => {
      const nextCode = normalizeScannedCode(barcode);

      const nextCanAutoSubmit =
        nextCode.length >= autoSubmitLongCodeLength ||
        (scannerEnabled && nextCode.length >= autoSubmitMinLength);

      if (!nextCode || !nextCanAutoSubmit || nextCode === lastSubmittedCodeRef.current) {
        return;
      }

      lastSubmittedCodeRef.current = nextCode;
      onSubmit(nextCode);
    }, autoSubmitDelayMs);

    return () => window.clearTimeout(timeout);
  }, [barcode, cameraActive, isPending, onSubmit, scannerEnabled]);

  function submitBarcode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitCode(barcode);
  }

  function submitCode(value: string) {
    const code = normalizeScannedCode(value);

    if (!code || code === lastSubmittedCodeRef.current) {
      return;
    }

    lastSubmittedCodeRef.current = code;
    onSubmit(code);
  }

  function handleBarcodeChange(event: ChangeEvent<HTMLInputElement>) {
    onBarcodeChange(event.target.value);
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
      <div className="mb-3 flex flex-wrap gap-2">
        <Button
          type="button"
          className="h-11"
          variant={scannerEnabled ? 'default' : 'outline'}
          onClick={onEnableScanner}
        >
          <ScanLine className="h-4 w-4" />
          Activar lector
        </Button>
        {showCamera ? (
          <Button type="button" className="h-11" variant="outline" onClick={onStartCamera}>
            <Camera className="h-4 w-4" />
            Camara QR
          </Button>
        ) : null}
        {scannerEnabled ? (
          <Button type="button" className="h-11" variant="ghost" onClick={onDisableScanner}>
            <X className="h-4 w-4" />
            Apagar
          </Button>
        ) : null}
      </div>

      <form className="flex gap-2" onSubmit={submitBarcode}>
        <div className="relative flex-1">
          <Barcode className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={barcodeInputRef}
            value={barcode}
            onChange={handleBarcodeChange}
            onBlur={() => {
              if (keepFocus && scannerEnabled && !cameraActive) {
                window.setTimeout(() => barcodeInputRef.current?.focus(), 40);
              }
            }}
            className="h-11 pl-9"
            placeholder="Escanea o escribe codigo QR o codigo de barras"
            autoComplete="off"
            inputMode="text"
          />
        </div>
        <Button
          className="h-11 w-11 px-0"
          type="submit"
          disabled={isPending}
          aria-label="Buscar por codigo"
        >
          <Search className="h-4 w-4" />
        </Button>
      </form>

      {showCamera && cameraActive ? (
        <video
          ref={videoRef}
          className="mt-3 aspect-video w-full rounded-md bg-black object-cover"
          muted
        />
      ) : null}

      {scannerMessage ? (
        <p className="mt-2 text-sm text-muted-foreground">{scannerMessage}</p>
      ) : null}
    </div>
  );
}

function normalizeScannedCode(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .replace(/\s+/g, '');
}
