const ALLOWED_HOSTS = new Set(['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com']);
const MEDIA_PATH_PATTERN = /^\/ii\/[A-Za-z0-9]{8,64}(\/[A-Za-z0-9]{1,16}){2}\/[A-Za-z0-9_-]{4,64}\.(webp|gif)$/;
const MAX_URL_LENGTH = 300;

export function isAllowedGifMediaUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_URL_LENGTH || !rawUrl.startsWith('https://') || /[?#@\\%]/.test(rawUrl)) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.href !== rawUrl) {
    return false;
  }

  return (
    url.protocol === 'https:' &&
    ALLOWED_HOSTS.has(url.hostname) &&
    url.host === url.hostname &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    MEDIA_PATH_PATTERN.test(url.pathname)
  );
}
