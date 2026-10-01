/** The files in public/, by name, bundled into the binary by scripts/build-binary.ts. */
declare module 'promptd:public' {
  const files: Record<string, string>;
  export default files;
}

/** scripts/install.sh and scripts/register-app-mac-os.sh, bundled into the binary by scripts/build-binary.ts. */
declare module 'promptd:scripts' {
  const scripts: { install: string; register: string };
  export default scripts;
}
