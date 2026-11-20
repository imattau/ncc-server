import { describe, expect, it } from 'vitest';

import { mediaPreviewTarget } from './mediaPreview';

describe('mediaPreviewTarget', () => {
  it('uses the media file as the image preview', () => {
    expect(
      mediaPreviewTarget({
        kind: 'image',
        mediaUrl: 'https://cdn.example.com/sunset.jpg',
        thumbnailUrl: 'https://cdn.example.com/sunset.jpg',
      }),
    ).toEqual({
      kind: 'image',
      src: 'https://cdn.example.com/sunset.jpg',
      poster: null,
    });
  });

  it('keeps a video poster when one was published', () => {
    expect(
      mediaPreviewTarget({
        kind: 'video',
        mediaUrl: 'https://cdn.example.com/clip.mp4',
        thumbnailUrl: 'https://cdn.example.com/poster.jpg',
      }),
    ).toEqual({
      kind: 'video',
      src: 'https://cdn.example.com/clip.mp4',
      poster: 'https://cdn.example.com/poster.jpg',
    });
  });

  it('still previews a video that has no poster', () => {
    expect(
      mediaPreviewTarget({
        kind: 'short-video',
        mediaUrl: 'https://cdn.example.com/clip.mp4',
        thumbnailUrl: null,
      }),
    ).toEqual({
      kind: 'video',
      src: 'https://cdn.example.com/clip.mp4',
      poster: null,
    });
  });

  it('returns null when there is no launchable media URL', () => {
    expect(mediaPreviewTarget({ kind: 'video', mediaUrl: null, thumbnailUrl: null })).toBeNull();
    expect(
      mediaPreviewTarget({ kind: 'image', mediaUrl: 'ipfs://example/x.jpg', thumbnailUrl: null }),
    ).toBeNull();
    expect(
      mediaPreviewTarget({
        kind: 'article',
        mediaUrl: 'https://cdn.example.com/x.jpg',
        thumbnailUrl: null,
      }),
    ).toBeNull();
  });
});
