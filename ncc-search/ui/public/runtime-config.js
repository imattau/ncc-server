// The embedding app may pass its configured read relays in the page URL.
// Keep the setting on the app side as the single source of truth.
const nccSearchParams = new URLSearchParams(window.location.search);
window.NCC_SEARCH_RELAYS_B64 = nccSearchParams.get('relays') || '';
window.NCC_SEARCH_PUBKEY = nccSearchParams.get('pubkey') || '';
