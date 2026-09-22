/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SHOW_BETA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
