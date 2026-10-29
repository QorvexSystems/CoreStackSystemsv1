'use client';

type ScanFeedbackKind = 'success' | 'error';

type WindowWithWebkitAudio = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

export function playScanFeedback(kind: ScanFeedbackKind) {
  if (typeof window === 'undefined') {
    return;
  }

  const AudioContextConstructor =
    window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;

  try {
    if (AudioContextConstructor) {
      const context = new AudioContextConstructor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.value = kind === 'success' ? 880 : 220;
      gain.gain.value = 0.04;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + (kind === 'success' ? 0.08 : 0.14));
      window.setTimeout(() => void context.close(), 220);
    }
  } catch {
    // Audio feedback is optional; scanning should never fail because the browser blocked sound.
  }

  if ('vibrate' in navigator) {
    navigator.vibrate(kind === 'success' ? 35 : [35, 40, 35]);
  }
}
