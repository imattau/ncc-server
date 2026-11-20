/**
 * Pure planning for the node-agent's unused-image clean-up.
 *
 * Every pull leaves the previous release's tags on the host: Compose replaces
 * the container and Docker keeps the image because a tag still points at it.
 * The agent can remove those, but only the ones that are unambiguously the
 * bundle's own and not in use, so this module does all of the deciding without
 * touching Docker and can be tested on its own.
 *
 * Rules, all deliberately conservative:
 *  - Only repositories a project container currently runs are considered. An
 *    image from another project, or a repository the bundle stopped using, is
 *    left alone.
 *  - An image used by any container of this Compose project (running or
 *    stopped) is never a candidate.
 *  - Dangling images have no tag and no repository, so they are not
 *    attributable to the bundle; `docker image prune` remains the tool for
 *    those.
 *  - `keepPrevious` keeps the newest unused version tag in each repository,
 *    which is the last release a manual rollback would check out. The panel
 *    offers turning it off for a full clean-up.
 */

/** `registry:5000/team/app:1.2.3@sha256:…` -> `registry:5000/team/app`, else null. */
export function imageRepo(ref) {
  if (typeof ref !== 'string') return null;
  const withoutDigest = ref.split('@')[0].trim();
  if (!withoutDigest) return null;
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  const repo = colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
  return repo || null;
}

/** `repo:tag` -> `tag`; null for a digest reference or a bare repository. */
export function imageTag(ref) {
  if (typeof ref !== 'string' || ref.includes('@')) return null;
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon <= slash) return null;
  const tag = ref.slice(colon + 1).trim();
  return tag || null;
}

/** `v1.2.3` / `1.2.3` -> `[1, 2, 3]`; anything else, including `latest`, null. */
export function versionParts(tag) {
  if (typeof tag !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Plan a clean-up from Docker's image list and the project's containers.
 *
 * `images` is `GET /images/json` (`Id`, `RepoTags`, `Size`, `Created`).
 * `containers` is the agent's project-scoped list (`image`, `imageId`).
 *
 * Returns the candidates (oldest first), the images kept only because they
 * hold the previous release tag, and the repositories that were in scope. The
 * byte total is Docker's per-image `Size`, which counts shared layers in each
 * image, so it is an upper bound; the agent reports the real difference from
 * `/system/df` after a delete.
 */
export function planImagePrune({ images, containers, keepPrevious = true } = {}) {
  const projectContainers = asArray(containers);
  const repositories = [...new Set(
    projectContainers
      .map((container) => imageRepo(container?.image))
      .filter((repo) => typeof repo === 'string' && repo.length > 0),
  )].sort();

  const inUse = new Set(
    projectContainers
      .map((container) => (typeof container?.imageId === 'string' ? container.imageId : null))
      .filter(Boolean),
  );

  if (repositories.length === 0) {
    return { repositories, images: [], kept: [], estimateBytes: 0 };
  }

  const scope = new Set(repositories);
  const byId = new Map();

  for (const image of asArray(images)) {
    const imageId = typeof image?.Id === 'string' ? image.Id : null;
    if (!imageId) continue;

    const refs = asArray(image.RepoTags)
      .filter((tag) => typeof tag === 'string' && scope.has(imageRepo(tag)));
    if (!refs.length) continue;

    const existing = byId.get(imageId);
    if (existing) {
      for (const ref of refs) {
        if (!existing.refs.includes(ref)) existing.refs.push(ref);
      }
      continue;
    }

    byId.set(imageId, {
      imageId,
      refs: [...new Set(refs)],
      sizeBytes: Number.isFinite(image.Size) && image.Size > 0 ? image.Size : null,
      created: Number.isFinite(image.Created) ? image.Created : null,
      inUse: inUse.has(imageId),
    });
  }

  const candidates = [...byId.values()].filter((image) => !image.inUse);
  if (!candidates.length) {
    return { repositories, images: [], kept: [], estimateBytes: 0 };
  }

  // The newest unused version tag in each repository is the previous release.
  // A repository with only non-version tags (latest, main, a date) has no
  // previous release to keep.
  const keepTagByRepo = new Map();
  if (keepPrevious) {
    for (const image of candidates) {
      for (const ref of image.refs) {
        const repo = imageRepo(ref);
        const version = versionParts(imageTag(ref));
        if (!repo || !version) continue;
        const current = keepTagByRepo.get(repo);
        if (!current || compareVersions(version, current.version) > 0) {
          keepTagByRepo.set(repo, { ref, version });
        }
      }
    }
  }

  const keepRefs = new Set([...keepTagByRepo.values()].map((entry) => entry.ref));
  const imagesOut = [];
  const kept = [];

  for (const image of candidates) {
    const entry = {
      imageId: image.imageId,
      refs: image.refs,
      sizeBytes: image.sizeBytes,
      created: image.created,
    };
    if (image.refs.some((ref) => keepRefs.has(ref))) {
      kept.push({ ...entry, reason: 'previous-release' });
    } else {
      imagesOut.push(entry);
    }
  }

  imagesOut.sort((left, right) => (left.created ?? Infinity) - (right.created ?? Infinity));

  return {
    repositories,
    images: imagesOut,
    kept,
    estimateBytes: imagesOut.reduce((total, image) => total + (image.sizeBytes ?? 0), 0),
  };
}

/** `'0'`/`'false'`/`'no'` -> false; `'1'`/`'true'`/`'yes'` -> true; else the fallback. */
export function parseKeepPrevious(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  return fallback;
}

function imagePayload(image) {
  return {
    ref: image.refs[0] ?? null,
    refs: image.refs,
    imageId: image.imageId,
    sizeBytes: image.sizeBytes,
    createdAt: Number.isFinite(image.created)
      ? new Date(image.created * 1000).toISOString()
      : null,
  };
}

/** The preview payload the panel renders before anything is deleted. */
export function prunePreview(plan, keepPrevious) {
  return {
    keepPrevious,
    count: plan.images.length,
    estimateBytes: plan.estimateBytes,
    images: plan.images.map(imagePayload),
    kept: plan.kept.map((image) => ({ ...imagePayload(image), reason: image.reason })),
    repositories: plan.repositories,
  };
}
