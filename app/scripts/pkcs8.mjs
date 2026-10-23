// Converts GitHub's PKCS#1 private key ("BEGIN RSA PRIVATE KEY") to PKCS#8
// ("BEGIN PRIVATE KEY"), the only RSA format WebCrypto can import.
// Same result as: openssl pkcs8 -topk8 -nocrypt -in private-key.pem

// rsaEncryption, 1.2.840.113549.1.1.1
const RSA_OID = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

function derLength(length) {
  if (length < 0x80) return [length];
  const bytes = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag, content) {
  return [tag, ...derLength(content.length), ...content];
}

function pemBody(pem, label) {
  const match = pem.match(new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`));
  if (!match) return null;
  return Uint8Array.from(atob(match[1].replace(/\s+/g, '')), (c) => c.charCodeAt(0));
}

function toPem(bytes, label) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

// Returns the key in PKCS#8 PEM format. A key that is already PKCS#8 is returned as is.
export function toPkcs8Pem(pem) {
  if (pemBody(pem, 'PRIVATE KEY')) return `${pem.trim()}\n`;
  const pkcs1 = pemBody(pem, 'RSA PRIVATE KEY');
  if (!pkcs1) throw new Error('The key is neither PKCS#1 (BEGIN RSA PRIVATE KEY) nor PKCS#8 (BEGIN PRIVATE KEY).');
  // PrivateKeyInfo ::= SEQUENCE { version 0, AlgorithmIdentifier { rsaEncryption, NULL }, OCTET STRING pkcs1 }
  const info = der(0x30, [...der(0x02, [0x00]), ...der(0x30, [...RSA_OID, 0x05, 0x00]), ...der(0x04, [...pkcs1])]);
  return toPem(Uint8Array.from(info), 'PRIVATE KEY');
}

// Proves the converted key works by importing it the way the Worker does.
export async function checkPkcs8(pem) {
  const body = pemBody(pem, 'PRIVATE KEY');
  await crypto.subtle.importKey('pkcs8', body, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
