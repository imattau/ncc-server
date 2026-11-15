/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NCC_SEARCH_API_BASE?: string;
  readonly VITE_NCC_SEARCH_RELAYS?: string;
  readonly VITE_NCC_SEARCH_IMAGE_CACHE_MAX_BYTES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
