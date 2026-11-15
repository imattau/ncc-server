/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NCC_SEARCH_API_BASE?: string;
  readonly VITE_NCC_SEARCH_RELAYS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
