import { describe, expect, it } from 'vitest';
import { pairOf } from '../friends/friends.repository.js';
import { AvatarUploads, signCloudinaryParams } from './avatar.js';

const cfg = { cloudName: 'demo', apiKey: '1234', apiSecret: 'shh', folder: 'codebattle/avatars' };
const USER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('Cloudinary signing', () => {
  it('matches the documented example signature', () => {
    // Example from Cloudinary's "Generating authentication signatures" docs.
    const sig = signCloudinaryParams(
      { eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510 },
      'abcd',
    );
    expect(sig).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });

  it('signs every upload field except api_key, scoped to the user id', () => {
    const s = new AvatarUploads(cfg).signature(USER, 1_731_000_000_000)!;
    expect(s.uploadUrl).toBe('https://api.cloudinary.com/v1_1/demo/image/upload');
    expect(s.fields).toMatchObject({
      public_id: USER,
      folder: 'codebattle/avatars',
      timestamp: '1731000000',
      api_key: '1234',
    });
    const { api_key: _k, signature, ...signed } = s.fields;
    expect(signature).toBe(signCloudinaryParams(signed, 'shh'));
    expect(new AvatarUploads(undefined).signature(USER)).toBeUndefined();
  });

  it("only accepts the user's own upload in our folder", () => {
    const a = new AvatarUploads(cfg);
    const ok = `https://res.cloudinary.com/demo/image/upload/v1731/codebattle/avatars/${USER}.webp`;
    expect(a.isAllowedUrl(ok, USER)).toBe(true);
    expect(
      a.isAllowedUrl(`https://res.cloudinary.com/demo/image/upload/codebattle/avatars/${USER}.png`, USER),
    ).toBe(true);
    for (const bad of [
      ok.replace(USER, '0193a1b2-c3d4-7e5f-8a9b-000000000000'), // someone else's avatar
      ok.replace('/demo/', '/other/'),
      ok.replace('https:', 'http:'),
      ok.replace('res.cloudinary.com', 'evil.example'),
      ok.replace('codebattle/avatars', 'codebattle/other'),
      `${ok}?x=1`,
      ok.replace('.webp', '.svg'),
      'not a url',
    ]) {
      expect(a.isAllowedUrl(bad, USER), bad).toBe(false);
    }
    expect(new AvatarUploads(undefined).isAllowedUrl(ok, USER)).toBe(false);
  });
});

describe('pairOf', () => {
  it('orders the pair canonically regardless of argument order or case', () => {
    const a = '0193a1b2-0000-7000-8000-00000000000a';
    const b = '0193A1B2-0000-7000-8000-00000000000B';
    expect(pairOf(a, b)).toEqual(pairOf(b, a));
    expect(pairOf(a, b)).toEqual({ low: a, high: b.toLowerCase() });
  });
});
