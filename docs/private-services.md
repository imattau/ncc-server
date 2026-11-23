# Private services and encrypted locators

A private NCC service keeps its endpoint out of the public record. Relays still
see the NCC-02 anchor and the NCC-05 locator exist and when they changed, but
the locator payload is NIP-44 encrypted to the recipient keys you choose. Only
those keys can decrypt the address.

This is **unlisting, not access control**. The service port is still open and
anyone who learns the endpoint can reach it. Use the service's own login, a
firewall or a tunnel when the content itself must be protected.

## What gets published

| Record | Public service | Private service |
| --- | --- | --- |
| NCC-02 anchor (`30059`) | includes `u`, `k`, `exp` | no `u`; keeps `k`, `exp`, `private` |
| NCC-05 locator (`30058`) | plaintext JSON | NIP-44 encrypted, `private` tag |

Private mode with no recipients publishes nothing. ncc-server always includes
the operator key, so the node can open its own service. Node admins are added
by default; use `NO_ADMINS=1` or the panel checkbox to opt out.

A single recipient uses the standard single-ciphertext form. Two or more
recipients use the wrapped form from `ncc-05-js` (one event, one encrypted
session key per recipient). NCC Browser reads both forms.

## CLI

```sh
# Show the current visibility and recipient count
sudo make service-list

# Encrypt one service to the operator, admins and two additional keys
sudo make service-private SERVICE=search \
  RECIPIENTS="npub1...,npub1..."

# Private but only the operator and the listed keys
sudo make service-private SERVICE=admin RECIPIENTS="npub1..." NO_ADMINS=1

# Publish the endpoint in plaintext again
sudo make service-public SERVICE=search
```

The equivalent script is `scripts/service-visibility.py`:

```sh
sudo python3 scripts/service_visibility.py set --service search --mode private \
  --recipients npub1... --no-admins --dry-run
sudo python3 scripts/service_visibility.py set --service all --mode private \
  --recipients npub1...
```

The command validates every key, merges the change into the service's existing
config so ports, certificates and Tor settings are untouched, and forces one
republish. `--dry-run` shows the plan without changing the sidecar.

`NCC_PRIVATE_SERVICES` and `NCC_PRIVATE_RECIPIENTS` in `.env` apply the same
policy during `make bundle-provision-services`. Re-provisioning preserves the
visibility and recipients already stored in the sidecar, so a later
provisioning run cannot silently make a private service public.

Custom package installs accept the same choices:

```sh
sudo make service-add PACKAGE=/path/to/package PRIVATE=1 RECIPIENTS="npub1..."
```

`service-install` accepts the same `PRIVATE=1`, `RECIPIENTS=...` and
`NO_ADMINS=1` values.

## Admin panel

**Installed** shows a **Private** badge on encrypted services and an **Access**
action on every service. The dialog offers:

- **Public** — plaintext locator, anyone with the address can resolve it.
- **Private** — an npub list of recipients, plus **Include node admin keys**.

The operator key is always listed by the sidecar, so saving a private service
without extra keys still lets the node open it. Saving republishes the record
immediately and refreshes the card's health and publication state.

The panel shows the recipient count rather than the endpoint, because the
browser cannot read an encrypted payload without a private key. The sidecar's
own `/ncc-api/services` response is the source for the recipient list.

## Opening and sharing

Recipients open the service in NCC Browser:

```
ncc://<operator-npub>/<service>/
```

They sign in with a key on the recipient list. A different identity gets an
`undecryptable` page that names the missing access instead of a broken page.
The administrator can also open it with the operator key.

Removing a recipient republishes the locator for the remaining keys; it does
not revoke an endpoint the removed person already copied. Rotate the endpoint
or enforce authentication when access must be cut off.

## Interaction with search

`ncc-search` deliberately does not decrypt locators and does not index private
NCC-02 anchors. Switching a service to private removes any public index entry
on the next crawl. Private services therefore stay out of the public search
results in both the server and nsite editions.

## Verification

```sh
sudo make service-list
```

Then check one relay event: a private locator has a `private` tag and no
readable endpoint in `content`; a public one contains `endpoints` JSON. Open
the `ncc://` address as a recipient and as a non-recipient to confirm the
difference.

The first release that includes this feature is `v0.2.23`.
