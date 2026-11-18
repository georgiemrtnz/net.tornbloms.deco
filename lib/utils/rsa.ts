import crypto, { createPublicKey, KeyObject } from 'crypto';

/**
 * Converts a hex string (as the router sends it) to unsigned big-endian
 * base64url, the encoding a JWK uses for `n` and `e`. Odd-length input gets a
 * leading zero nibble and leading zero bytes are dropped, so the key built
 * from it is the same one bn.js + an ASN.1 RSAPublicKey encoder produced.
 */
function hexToBase64Url(hex: string): string {
  let h = hex;
  if (h.length % 2) h = `0${h}`;
  let buf = Buffer.from(h, 'hex');
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0) start++;
  buf = buf.subarray(start);
  return buf.toString('base64url');
}

/**
 * Generates an RSA public key from provided modulus and exponent.
 *
 * Built with Node's own JWK import rather than asn1.js + bn.js, which were
 * only here to DER-encode (n, e); the resulting key is identical.
 *
 * @param data - An array where the first element is the modulus (hex) and the second is the exponent (hex).
 * @returns The generated RSA public key as a KeyObject or null if an error occurs.
 */
export function generateRsaKey(data: string[]): KeyObject | null {
  const exponent = parseInt(data[1], 16);

  if (isNaN(exponent)) {
    return null;
  }

  return createPublicKey({
    key: {
      kty: 'RSA',
      n: hexToBase64Url(data[0]),
      e: hexToBase64Url(exponent.toString(16)),
    },
    format: 'jwk',
  });
}

/**
 * Encrypts a message using the provided RSA public key.
 *
 * @param msg - The plaintext message to encrypt.
 * @param publicKey - The RSA public key used for encryption.
 * @returns The encrypted message as a hexadecimal string, or an empty string if an error occurs.
 */
export function encryptRsa(msg: string, publicKey: KeyObject): string {
  try {
    // Convert the message to a Buffer
    const messageBuffer = Buffer.from(msg, 'utf-8');

    // Determine the RSA key size in bits
    const keySize = publicKey.asymmetricKeyDetails?.modulusLength;
    if (!keySize) {
      throw new Error('Failed to determine RSA key size.');
    }

    // Encrypt the message using the RSA public key
    const cipher = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      messageBuffer,
    );

    // Convert the encrypted message to a hexadecimal string
    return cipher.toString('hex');
  } catch (e) {
    return '';
  }
}
