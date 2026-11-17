# NCC-Server Test App

This test page is built on Soapbox's [MKStack](https://soapbox.pub/mkstack),
using its React, TypeScript, Vite, Tailwind, and Nostrify setup. The source
template is the official [MKStack repository](https://gitlab.com/soapbox-pub/mkstack).

## What it checks

- Sends a `HEAD` request to the current page origin and displays the response
  time.
- Lets an operator enter a locator author's public `npub`.
- Queries the configured read relays for a fresh, signature-valid Kind 30058
  event and displays its endpoint, identifier, and expiry.
- Compares the advertised endpoint host with the current page host.

The lookup uses public relay data. It never asks for or handles an `nsec`.

## NCC Server panel prototype

The `/admin` route contains a clickable management-panel prototype built with
the same MKStack and Nostrify foundation. It includes overview, app catalog,
installed services, activity, operator-key admin management, and settings
screens. Sign-in, invitations, installs, and publication actions are demo-only;
they do not call the server or publish events.

Run `npm run dev` from this directory and open `http://localhost:8080/admin`.

## Build and serve

From the NCC-Server root:

```sh
make init-test-identity
make build-test-app
sudo make install
```

The identity initializer creates a random keypair once and stores it in
`.secrets/ncc-test-key.json` (mode 0600), which is excluded by the app's
`.gitignore`. It writes only the public npub to the app's ignored
`.env.local` file so the test page can prefill its lookup field. The nsec is
never included in the app bundle.

For VM testing, publish a short-lived signed locator from the host while the
VM serves the page:

```sh
NCC_TEST_ENDPOINT=http://<vm-address>:8080 make publish-test-locator
```

The host-only test command reads the ignored key file, signs a Kind 30058 event,
and sends it to the public test relays. Only the public npub and locator are
visible to the VM. This is a test fixture publisher; it does not replace or
configure `ncc-sidecar`.

The build writes its static output to `../public/`, the content folder staged
for Caddy. On an already installed host, rebuild and run `make deploy-test-app`
to copy the page to `/srv/ncc-server/public/`. Node is only needed to build the
app; the production host serves the generated files with Caddy.

To run the MKStack validation suite:

```sh
cd test-app
npm ci
npm test
```

The Stacks CLI's Nostr-hosted MKStack alias was unavailable from this network
environment, so this project was initialized from the upstream MKStack GitLab
source. It uses the same framework template and includes the framework credit
link in the page footer.
