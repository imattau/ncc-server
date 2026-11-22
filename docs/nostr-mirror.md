# Nostr git mirror

The canonical repository is on GitHub. A signed NIP-34 copy is published to
`relay.ngit.dev` and the other GRASP servers listed in its repository announcement:

```
nostr://npub1khf5amw8mrupe649a5mhkk3d2d8wjj06urz6kwawpftk4f68tjlstdmd3q/relay.ngit.dev/ncc-server
```

Browse it at
[gitworkshop.dev](https://gitworkshop.dev/npub1khf5amw8mrupe649a5mhkk3d2d8wjj06urz6kwawpftk4f68tjlstdmd3q/relay.ngit.dev/ncc-server).

## How it stays in sync

`.github/workflows/nostr-mirror.yml` runs on every push to `main`, every `v*` tag, and
on demand. It:

1. Installs the pinned [ngit](https://ngit.dev/install) release and its
   `git-remote-nostr` helper.
2. Pushes GitHub `main` to `refs/heads/main` on the `nostr://` remote.
3. Pushes every tag, so release tags match GitHub.
4. Verifies the remote `main` matches the pushed commit.

The push updates the signed kind 30618 repository state and lets the GRASP servers
(`relay.ngit.dev`, `git.shakespeare.diy`, `git.nostrHub.io`) serve the same commits. A
normal ngit push already updates the servers; no separate `ngit sync` is needed.

## Required secret

Set the repository secret **`NGIT_NSEC`** to the nsec for
`npub1khf5amw8mrupe649a5mhkk3d2d8wjj06urz6kwawpftk4f68tjlstdmd3q` (the repository
owner and the identity that already owns the mirror). This is the same mirror identity
used by `ncc-browser`; it is not the node operator key and not the npack publisher key.

Add it from a machine that already holds the key:

```bash
gh secret set NGIT_NSEC --repo imattau/ncc-server
# paste the nsec when prompted
```

or through **Settings → Secrets and variables → Actions → New repository secret**.

Without the secret the workflow reports a warning and skips, so ordinary pushes stay
green. Set it once and every later push and release tag mirrors automatically.

## Releases

Release tags are mirrored with the commits they point to. This repository uses
lightweight tags, and the release notes are committed as `docs/releases/<tag>.md` in
the tagged commit, so the notes mirror with the repository. The GitHub release itself
is created by the image workflow once the component images are published (see
`docs/releases/README.md`).

This workflow does **not** republish release artifacts as NIP-82 release events or
upload them to Blossom.

## Manual run

```bash
gh workflow run nostr-mirror.yml --repo imattau/ncc-server
```

Check the run summary for the mirrored commit and the count of version tags.
