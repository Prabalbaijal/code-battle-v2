import type { AvatarUploadSignature } from '@cb/contracts';
import { createHash } from 'node:crypto';

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
}

/** Client-side size check; Cloudinary also enforces its plan's max image size. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const FORMATS = ['jpg', 'png', 'webp'] as const;
/** Incoming transformation: stored image is a 256×256 face-centred crop (plan §16). */
const TRANSFORMATION = 'c_fill,g_face,w_256,h_256';

/**
 * Cloudinary upload signature: sort the signed params, join as `k=v&k=v`, append the API secret,
 * SHA-1 hex. `file`, `api_key`, `cloud_name` and `resource_type` are never signed.
 */
export function signCloudinaryParams(params: Record<string, string | number>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1')
    .update(toSign + apiSecret)
    .digest('hex');
}

/** Signed direct uploads. The API never sees the image bytes. */
export class AvatarUploads {
  constructor(private readonly cfg: CloudinaryConfig | undefined) {}

  get enabled(): boolean {
    return this.cfg !== undefined;
  }

  /** The public_id is the user id, so a user can only ever overwrite their own avatar. */
  signature(userId: string, now = Date.now()): AvatarUploadSignature | undefined {
    if (!this.cfg) return undefined;
    const signed = {
      allowed_formats: FORMATS.join(','),
      folder: this.cfg.folder,
      invalidate: 'true',
      overwrite: 'true',
      public_id: userId,
      timestamp: Math.floor(now / 1000),
      transformation: TRANSFORMATION,
    };
    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.cfg.cloudName}/image/upload`,
      fields: {
        ...Object.fromEntries(Object.entries(signed).map(([k, v]) => [k, String(v)])),
        api_key: this.cfg.apiKey,
        signature: signCloudinaryParams(signed, this.cfg.apiSecret),
      },
      maxBytes: AVATAR_MAX_BYTES,
    };
  }

  /**
   * Only accept avatar URLs of this user's own upload in our folder (plan §16), e.g.
   * https://res.cloudinary.com/<cloud>/image/upload/v1731/<folder>/<userId>.webp
   */
  isAllowedUrl(url: string, userId: string): boolean {
    if (!this.cfg) return false;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:' || u.hostname !== 'res.cloudinary.com' || u.search || u.hash) return false;
    const prefix = `/${this.cfg.cloudName}/image/upload/`;
    if (!u.pathname.startsWith(prefix)) return false;
    const rest = u.pathname.slice(prefix.length).replace(/^v\d+\//, '');
    return new RegExp(`^${this.cfg.folder}/${userId}\\.(${FORMATS.join('|')})$`).test(rest);
  }
}
