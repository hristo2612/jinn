declare module 'des.js' {
  export namespace DES {
    function create(opts: {
      type: 'encrypt' | 'decrypt';
      key: Buffer | Uint8Array;
    }): { update(data: Buffer | Uint8Array): number[] | Buffer };
  }
  const _default: { DES: typeof DES };
  export default _default;
}
