# nsite publisher for nccsearch

A small standalone page that publishes the nsite edition of
[ncc-search](../ui/README.md#nsite-edition-no-server) as a NIP-5A site:

1. pick the built `dist-nsite/` folder,
2. hash every file (SHA-256, locally),
3. upload each blob to Blossom (BUD-02) using a **NIP-07 signer**,
4. sign a `kind:35128` manifest listing every `path` and `server`, and
5. publish it to relays, then optionally verify every uploaded file against
   its manifest hash.

No private key ever reaches the page: the signer only returns a pubkey and
signed events.

## Run

```bash
cd ncc-search/ui
npm install
npm run build:nsite        # -> dist-nsite/

cd ../nsite-publisher
npm install
npm run dev                # http://127.0.0.1:5174
```

Open `http://127.0.0.1:5174` in Nostr Navigator (which has its own signer) or in
any browser with a NIP-07 extension, then:

1. **Choose build folder** → `ncc-search/ui/dist-nsite` itself, not its parent.
2. Fill in the site id (`nccsearch` by default), title, description and source.
3. **Connect signer**, approve the browser's prompt.
4. **Upload and publish**.

The result includes the address `nsite://<your npub>/nccsearch`, the manifest
event id and the per-relay accept/reject messages. **Verify uploaded files**
downloads every file back from the manifest's servers and checks the bytes
against their hashes — worth doing once, because a manifest that points at
missing blobs is a broken site that looks fine until someone opens it.

To use the page inside Nostr Navigator, run the dev server and type
`http://127.0.0.1:5174` in the address bar; the built-in signer shows its
normal per-origin approval sheet.

## Notes

- **Blossom servers must accept uploads from your key.** The defaults are
  `blossom.ditto.pub`, `nostr.download` and `blossom.primal.net`; some servers
  whitelist accounts or reject unknown keys, and the log shows exactly which
  one refused and why. Every file is uploaded to every working server, so a
  reader has more than one place to fetch it, and all of those servers go into
  the manifest's `server` tags.
- CORS is required for browser uploads. `blossom.ditto.pub` and
  `nostr.download` send `Access-Control-Allow-Origin: *`; a server that does
  not will fail with a network error rather than an HTTP status.
- The site id follows the client grammar: 1–13 lowercase letters, digits and
  dashes, not ending in a dash. `nccsearch` fits; a longer name does not.
- Republishing after a rebuild is the same flow. Files that are already on a
  server are skipped (Blossom addresses are hashes), so only new assets upload,
  and a new manifest replaces the old one.
- This page can itself be published as an nsite (choose its own `dist/`), so
  later publishes need nothing running locally. Bootstrap it once from the dev
  server.
- The form fields are remembered in `localStorage`; the selected folder is not
  (a `File` is not serialisable), so each publish starts with choosing the
  folder again.

## Test

```bash
npm test
```

Covers site-id/path validation, manifest construction and signature
verification, the address format, hashing, base64 encoding and MIME inference.
The network side (real Blossom uploads, real relay acceptance) needs a signer
and is exercised by publishing.
