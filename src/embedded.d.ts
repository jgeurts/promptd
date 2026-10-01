/** The files in public/, by name, bundled into the binary by scripts/build-binary.ts. */
declare module 'promptd:public' {
  const files: Record<string, string>;
  export default files;
}
