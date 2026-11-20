import test from 'node:test';
import assert from 'node:assert/strict';

import {
  imageRepo,
  imageTag,
  parseKeepPrevious,
  planImagePrune,
  prunePreview,
  versionParts,
} from '../prune-state.mjs';

const container = (image, imageId) => ({ image, imageId });
const image = (id, tags, { size = 100, created = 1 } = {}) => ({
  Id: id,
  RepoTags: tags,
  Size: size,
  Created: created,
});

test('image references: a registry port is not a tag', () => {
  assert.equal(imageRepo('ghcr.io/imattau/ncc-server-search:0.2.16'), 'ghcr.io/imattau/ncc-server-search');
  assert.equal(imageRepo('registry.example:5000/team/app:1.2.3'), 'registry.example:5000/team/app');
  assert.equal(imageRepo('registry.example:5000/team/app'), 'registry.example:5000/team/app');
  assert.equal(imageRepo('ghcr.io/imattau/ncc-server-search@sha256:abc'), 'ghcr.io/imattau/ncc-server-search');
  assert.equal(imageRepo(null), null);

  assert.equal(imageTag('ghcr.io/imattau/ncc-server-search:0.2.16'), '0.2.16');
  assert.equal(imageTag('registry.example:5000/team/app:1.2.3'), '1.2.3');
  assert.equal(imageTag('registry.example:5000/team/app'), null);
  assert.equal(imageTag('registry.example/app@sha256:abc'), null);
});

test('versions: only plain v?major.minor.patch tags compare', () => {
  assert.deepEqual(versionParts('0.2.16'), [0, 2, 16]);
  assert.deepEqual(versionParts('v0.2.16'), [0, 2, 16]);
  for (const tag of ['latest', 'main', '0.2', '0.2.16-rc1', '', null]) {
    assert.equal(versionParts(tag), null, String(tag));
  }
});

test('keepPrevious: accepts the panel and query forms, defaults to true', () => {
  assert.equal(parseKeepPrevious(undefined), true);
  assert.equal(parseKeepPrevious('1'), true);
  assert.equal(parseKeepPrevious('true'), true);
  assert.equal(parseKeepPrevious('0'), false);
  assert.equal(parseKeepPrevious('false'), false);
  assert.equal(parseKeepPrevious(false), false);
  assert.equal(parseKeepPrevious('maybe'), true);
  assert.equal(parseKeepPrevious(undefined, false), false);
});

test('plan: an image any project container uses is never removed', () => {
  const plan = planImagePrune({
    containers: [
      container('ghcr.io/imattau/ncc-server-search:0.2.16', 'sha256:current'),
      container('ghcr.io/imattau/ncc-server-relay:0.2.16', 'sha256:relay'),
    ],
    images: [
      image('sha256:current', ['ghcr.io/imattau/ncc-server-search:0.2.16']),
      image('sha256:relay', ['ghcr.io/imattau/ncc-server-relay:0.2.16']),
    ],
  });

  assert.deepEqual(plan.repositories, [
    'ghcr.io/imattau/ncc-server-relay',
    'ghcr.io/imattau/ncc-server-search',
  ]);
  assert.deepEqual(plan.images, []);
  assert.deepEqual(plan.kept, []);
  assert.equal(plan.estimateBytes, 0);
});

test('plan: an unused old release is a candidate, oldest first', () => {
  const plan = planImagePrune({
    keepPrevious: false,
    containers: [container('ghcr.io/imattau/ncc-server-search:0.2.16', 'sha256:current')],
    images: [
      image('sha256:current', ['ghcr.io/imattau/ncc-server-search:0.2.16'], { size: 50, created: 3 }),
      image('sha256:old', ['ghcr.io/imattau/ncc-server-search:0.2.14'], { size: 80, created: 1 }),
      image('sha256:previous', ['ghcr.io/imattau/ncc-server-search:0.2.15'], { size: 90, created: 2 }),
    ],
  });

  assert.deepEqual(plan.images.map((entry) => entry.refs[0]), [
    'ghcr.io/imattau/ncc-server-search:0.2.14',
    'ghcr.io/imattau/ncc-server-search:0.2.15',
  ]);
  assert.equal(plan.estimateBytes, 170);
  assert.deepEqual(plan.kept, []);
});

test('plan: keepPrevious keeps the newest unused version in each repository', () => {
  const plan = planImagePrune({
    keepPrevious: true,
    containers: [
      container('ghcr.io/imattau/ncc-server-search:0.2.16', 'sha256:current'),
      container('ghcr.io/imattau/ncc-server-relay:0.2.16', 'sha256:relay'),
    ],
    images: [
      image('sha256:current', ['ghcr.io/imattau/ncc-server-search:0.2.16'], { created: 4 }),
      image('sha256:relay', ['ghcr.io/imattau/ncc-server-relay:0.2.16'], { created: 4 }),
      image('sha256:search-prev', ['ghcr.io/imattau/ncc-server-search:0.2.15'], { created: 3 }),
      image('sha256:search-old', ['ghcr.io/imattau/ncc-server-search:0.2.14'], { created: 1 }),
      image('sha256:relay-prev', ['ghcr.io/imattau/ncc-server-relay:0.2.15'], { created: 3 }),
    ],
  });

  assert.deepEqual(plan.images.map((entry) => entry.refs[0]), [
    'ghcr.io/imattau/ncc-server-search:0.2.14',
  ]);
  assert.deepEqual(plan.kept.map((entry) => entry.refs[0]).sort(), [
    'ghcr.io/imattau/ncc-server-relay:0.2.15',
    'ghcr.io/imattau/ncc-server-search:0.2.15',
  ]);
  assert.equal(plan.kept[0].reason, 'previous-release');
});

test('plan: a repository with only non-version tags keeps nothing', () => {
  const plan = planImagePrune({
    keepPrevious: true,
    containers: [container('ghcr.io/acme/app:latest', 'sha256:current')],
    images: [
      image('sha256:current', ['ghcr.io/acme/app:latest']),
      image('sha256:old', ['ghcr.io/acme/app:main'], { created: 1 }),
    ],
  });

  assert.deepEqual(plan.images.map((entry) => entry.refs[0]), ['ghcr.io/acme/app:main']);
  assert.deepEqual(plan.kept, []);
});

test('plan: images outside the project repositories are ignored', () => {
  const plan = planImagePrune({
    containers: [container('ghcr.io/imattau/ncc-server-sidecar:0.2.16', 'sha256:current')],
    images: [
      image('sha256:current', ['ghcr.io/imattau/ncc-server-sidecar:0.2.16']),
      image('sha256:other', ['ghcr.io/someone/else:1.0.0']),
      image('sha256:dangling', null),
    ],
  });

  assert.deepEqual(plan.images, []);
});

test('plan: an image with several project tags is reported once', () => {
  const plan = planImagePrune({
    keepPrevious: false,
    containers: [container('ghcr.io/imattau/ncc-server-search:0.2.16', 'sha256:current')],
    images: [
      image('sha256:current', ['ghcr.io/imattau/ncc-server-search:0.2.16']),
      image('sha256:old', [
        'ghcr.io/imattau/ncc-server-search:0.2.15',
        'ghcr.io/imattau/ncc-server-search:latest',
        'registry.example/other:keep',
      ]),
    ],
  });

  assert.equal(plan.images.length, 1);
  assert.deepEqual(plan.images[0].refs, [
    'ghcr.io/imattau/ncc-server-search:0.2.15',
    'ghcr.io/imattau/ncc-server-search:latest',
  ]);
});

test('plan: no project containers means no scope and no candidates', () => {
  const plan = planImagePrune({
    containers: [],
    images: [image('sha256:old', ['ghcr.io/imattau/ncc-server-search:0.2.15'])],
  });

  assert.deepEqual(plan.repositories, []);
  assert.deepEqual(plan.images, []);
  assert.equal(plan.estimateBytes, 0);
});

test('plan: missing or malformed input never throws', () => {
  assert.deepEqual(planImagePrune(), {
    repositories: [], images: [], kept: [], estimateBytes: 0,
  });
  assert.deepEqual(planImagePrune({ images: null, containers: null }), {
    repositories: [], images: [], kept: [], estimateBytes: 0,
  });
  assert.deepEqual(planImagePrune({ images: [null, 3], containers: [null] }), {
    repositories: [], images: [], kept: [], estimateBytes: 0,
  });
});

test('preview: reports the plan without inventing sizes or dates', () => {
  const preview = prunePreview(
    planImagePrune({
      keepPrevious: false,
      containers: [container('ghcr.io/imattau/ncc-server-search:0.2.16', 'sha256:current')],
      images: [
        image('sha256:current', ['ghcr.io/imattau/ncc-server-search:0.2.16']),
        image('sha256:old', ['ghcr.io/imattau/ncc-server-search:0.2.15'], {
          size: 2048,
          created: 1_700_000_000,
        }),
        { Id: 'sha256:unknown', RepoTags: ['ghcr.io/imattau/ncc-server-search:0.2.14'] },
      ],
    }),
    false,
  );

  assert.equal(preview.keepPrevious, false);
  assert.equal(preview.count, 2);
  assert.equal(preview.estimateBytes, 2048);
  assert.deepEqual(preview.images[0], {
    ref: 'ghcr.io/imattau/ncc-server-search:0.2.15',
    refs: ['ghcr.io/imattau/ncc-server-search:0.2.15'],
    imageId: 'sha256:old',
    sizeBytes: 2048,
    createdAt: new Date(1_700_000_000 * 1000).toISOString(),
  });
  assert.equal(preview.images[1].sizeBytes, null);
  assert.equal(preview.images[1].createdAt, null);
  assert.deepEqual(preview.kept, []);
});
