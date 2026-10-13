// Creates an RS256 key pair for signing access tokens (local dev only).
// The private key stays with the user service; other services get the public key.
const { generateKeyPairSync } = require('crypto');
const { existsSync, mkdirSync, writeFileSync } = require('fs');

const force = process.argv.includes('--force');
if (existsSync('keys/jwt-private.pem') && !force) {
  console.log('keys/jwt-private.pem already exists (use --force to replace)');
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

mkdirSync('keys', { recursive: true });
writeFileSync('keys/jwt-private.pem', privateKey, { mode: 0o600 });
writeFileSync('keys/jwt-public.pem', publicKey);
console.log('Keys created in ./keys');
