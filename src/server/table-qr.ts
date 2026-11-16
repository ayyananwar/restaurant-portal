import QRCode from 'qrcode';

export function tableQrPreviewUrl(input: string | undefined) {
  if (!input) return;
  const url = URL.parse(input);
  if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || url.search || url.hash || !/^\/r\/[a-z0-9][a-z0-9-]{0,62}$/.test(url.pathname)) {
    throw new Error('The table card preview requires a loopback guest menu URL.');
  }
  return url.href;
}

export function renderTableQr(menuUrl: string, id: number) {
  return QRCode.toString(`${menuUrl}#table-${id}`, {
    type: 'svg', margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' }
  });
}
