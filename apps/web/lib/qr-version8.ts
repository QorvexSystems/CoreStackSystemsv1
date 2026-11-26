export { analyzeQr, planDgiiQr } from '../../../packages/fiscal/src/qr-capacity';
import { analyzeQr } from '../../../packages/fiscal/src/qr-capacity';

/** Compatibility name retained for diagnostics that specifically measure v8-L. */
export const analyzeQrVersion8 = (value: string) => analyzeQr(value, 8);
