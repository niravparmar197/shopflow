// DEV ONLY: signs access tokens for N made-up customers with the LOCAL
// private key, for load tests (k6) and manual flash-sale tests. The users
// don't exist in the user service; the other services only check the token.
//
//   node scripts/make-test-tokens.js 1000
//   → load-tests/.data/tokens.json  [{ userId, token }]  (git-ignored)
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');

if (process.env.NODE_ENV === 'production') {
  throw new Error('make-test-tokens is for development only');
}

const n = Number(process.argv[2] || 10);
const key = fs.readFileSync('keys/jwt-private.pem');
const users = Array.from({ length: n }, (_, i) => {
  const userId = randomUUID();
  return {
    userId,
    token: jwt.sign(
      { sub: userId, email: `buyer${i}@load.test`, role: 'customer' },
      key,
      {
        algorithm: 'RS256',
        issuer: 'shopflow',
        audience: 'shopflow-api',
        expiresIn: '2h',
      },
    ),
  };
});
fs.mkdirSync('load-tests/.data', { recursive: true });
fs.writeFileSync('load-tests/.data/tokens.json', JSON.stringify(users));
console.log(`Wrote ${n} user tokens to load-tests/.data/tokens.json`);
