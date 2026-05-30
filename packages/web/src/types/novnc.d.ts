// Ambient declaration for @novnc/novnc, which ships no TypeScript types.
// The package's `exports` maps the root to core/rfb.js, so the default export
// of '@novnc/novnc' is the RFB client class.
declare module '@novnc/novnc' {
  export default class RFB {
    constructor(target: Element, url: string, options?: any);
    scaleViewport: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    addEventListener(e: string, cb: (...a: any[]) => void): void;
    disconnect(): void;
  }
}
