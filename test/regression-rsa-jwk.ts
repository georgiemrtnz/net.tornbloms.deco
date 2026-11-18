// RSA key built from router hex (n, e) via JWK must equal the real key, and
// PKCS#1 v1.5 encryption must decrypt with the private key.
import assert from 'assert';
import crypto from 'crypto';
import { generateRsaKey, encryptRsa } from '../lib/utils/rsa';

for (const bits of [512, 1024, 2048]) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk: any = publicKey.export({ format: 'jwk' });
  const nHex = Buffer.from(jwk.n, 'base64url').toString('hex');
  const eHex = Buffer.from(jwk.e, 'base64url').toString('hex');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  for (const n of [nHex, nHex.toUpperCase(), `00${nHex}`]) {
    const k = generateRsaKey([n, eHex]);
    assert.ok(k);
    assert.ok(k!.export({ type: 'spki', format: 'der' }).equals(spki), 'SPKI DER identical');
    for (const msg of ['admin', 'p'.repeat(bits / 8 - 11)]) {
      const ct = encryptRsa(msg, k!);
      assert.strictEqual(ct.length, bits / 4);
      const pt = crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(ct, 'hex'),
      );
      assert.strictEqual(pt.toString(), msg);
    }
  }
}
assert.strictEqual(generateRsaKey(['abcd', 'zz']), null);
console.log('PASS: JWK-built RSA key is identical (SPKI DER) and PKCS#1 round-trips.');
