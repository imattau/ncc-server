# Release notes

Optional hand-written notes for a server release. The `Publish component
images` workflow creates the GitHub release for a `v*` tag **after** every
component image is in the registry, and reads the body from
`docs/releases/<tag>.md` when that file exists at the tagged commit:

```
docs/releases/v0.2.20.md
```

Add it before pushing the tag. Without the file the release uses GitHub's
generated notes. Keep the notes user-facing: what changed, how to verify it,
and any upgrade step beyond the normal `make bundle-upgrade REF=<tag>`.

## Release checklist

- Add `docs/releases/<tag>.md`.
- Bump the workflow refs in `examples/hello-service/.github/workflows/publish.yml`
  and `docs/build-a-service.md` to the new tag.
- Check the service templates and example with `make service-check` and the
  template runtime smoke test.
