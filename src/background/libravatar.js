import { queryAvatarService } from './dns.js';
import { buildSecureUrl, doSignaturesMatch, sha256sum } from './utils.js';
import { DEFAULT_HOST, DEFAULT_AVATAR } from '../constants.js';

/**
 * File signatures or magic numbers to check if the file received actually looks
 * like a valid JPEG or PNG image.
 *
 * Also contains a normalized version of the content type in the mapping as
 * Thunderbird is very picky.
 *
 * @see http://www.libpng.org/pub/png/spec/1.2/PNG-Structure.html
 */
export const SUPPORTED_CONTENT_TYPES = new Map([
  ['image/jpg', {
    contentType: 'image/jpeg',
    signature: [255, 216],
    tail: [255, 217]
  }],
  ['image/png', {
    contentType: 'image/png',
    signature: [137, 80, 78, 71, 13, 10, 26, 10],
    tail: null
  }]
]);

/**
 * Get the avatar for a given contact by email address.
 *
 * First attempts to check if the email has a dedicated Libravatar instance
 * associated with it. If not, we'll use the default instance at
 * {@link DEFAULT_HOST}.
 *
 * Even if the contact does use have a dedicated instance, there are times we're
 * unable to use it for example:
 *
 * * {@link https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Origin Access Control Origin Policy}
 * * An invalid or expired HTTPS certificate
 *
 * If this happens, we'll fallback to {@link DEFAULT_HOST}.
 *
 * If the file we get back does not start with a PNG file signature, we throw it
 * away as malformed or potentially malicious.
 *
 * @param {string} email
 * @param {number} size
 * @returns {Promise<?File>}
 */
export async function getAvatar(email, size) {
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split('@')[1];
  const dohOption = await messenger.storage.sync.get('dohServer');
  let dnsData;

  if (dohOption?.dohServer) {
    const { data } = await queryAvatarService(domain, dohOption.dohServer);
    dnsData = data;
  }

  const contactsInstance = (dnsData) ? buildSecureUrl(dnsData.target, dnsData.port) : DEFAULT_HOST;
  const emailHash = await sha256sum(normalized);

  let route = `/avatar/${emailHash}?s=${size}`;
  const avatarOption = await messenger.storage.sync.get('defaultAvatar');
  if (avatarOption?.defaultAvatar) {
    route += `&d=${avatarOption.defaultAvatar}`;
  } else if (avatarOption?.defaultAvatar !== '') {
    route += `&d=${DEFAULT_AVATAR}`;
  }

  let resp;

  try {
    resp = await fetch(contactsInstance + route, {
      signal: AbortSignal.timeout(3000)
    });
  } catch (err) {}

  if (!resp || !resp.ok) {
    let instanceOption = await messenger.storage.sync.get('preferredInstance');
    const preferredInstance = instanceOption?.preferredInstance || DEFAULT_HOST;

    if (preferredInstance === contactsInstance) {
      return null;
    }

    try {
      resp = await fetch(preferredInstance + route, {
        signal: AbortSignal.timeout(3000)
      });
    } catch (err) {
      return null;
    }
  }

  if (!resp.ok) {
    return null;
  }

  const contentTypeValue = resp.headers.get('content-type');

  if (!contentTypeValue) {
    return null;
  }

  const contentTypeMeta = SUPPORTED_CONTENT_TYPES.get(contentTypeValue);

  if (!contentTypeMeta) {
    return null;
  }

  const blob = await resp.blob();
  const matches = await doSignaturesMatch(
    blob,
    contentTypeMeta.signature,
    contentTypeMeta.tail
  );

  if (!matches) {
    return null;
  }

  return new File(
    [blob],
    `${emailHash}.${contentTypeMeta.contentType.split('/')[1]}`,
    { type: contentTypeMeta.contentType }
  );
}
