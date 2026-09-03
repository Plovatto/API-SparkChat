function detectOperatingSystem(userAgent: string): string {
  if (/iPhone/i.test(userAgent)) {
    return 'iPhone';
  }
  if (/iPad/i.test(userAgent)) {
    return 'iPad';
  }
  if (/Android/i.test(userAgent)) {
    return 'Android';
  }
  if (/Windows/i.test(userAgent)) {
    return 'Windows';
  }
  if (/Macintosh|Mac OS X/i.test(userAgent)) {
    return 'Mac';
  }
  if (/Linux/i.test(userAgent)) {
    return 'Linux';
  }
  return 'Dispositivo desconhecido';
}

function detectBrowser(userAgent: string): string | null {
  if (/Edg\//i.test(userAgent)) {
    return 'Edge';
  }
  if (/Chrome\//i.test(userAgent)) {
    return 'Chrome';
  }
  if (/Firefox\//i.test(userAgent)) {
    return 'Firefox';
  }
  if (/Safari\//i.test(userAgent)) {
    return 'Safari';
  }
  return null;
}

export function describeDevice(userAgent: string): string {
  if (!userAgent.trim()) {
    return 'Dispositivo desconhecido';
  }

  const os = detectOperatingSystem(userAgent);
  const browser = detectBrowser(userAgent);

  return browser ? `${browser} · ${os}` : os;
}
