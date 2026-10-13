// Uploads one product image the way a browser would: presigned POST straight
// to S3/MinIO, then confirm. Needs Node 18+ (fetch, FormData, Blob).
//
//   node scripts/upload-image.js <productId> <file.jpg|png|webp> <adminToken>
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const BASE = process.env.API_URL ?? 'http://localhost:3000';

async function main() {
  const [productId, filePath, token] = process.argv.slice(2);
  if (!productId || !filePath || !token) {
    throw new Error(
      'usage: node scripts/upload-image.js <productId> <file> <adminToken>',
    );
  }
  const contentType = TYPES[path.extname(filePath).toLowerCase()];
  if (!contentType) throw new Error('file must be .jpg, .jpeg, .png or .webp');
  const bytes = fs.readFileSync(filePath);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // 1) Ask our API for a presigned POST.
  const r1 = await fetch(`${BASE}/v1/products/${productId}/images/upload-url`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ contentType, sizeBytes: bytes.length }),
  });
  const up = await r1.json();
  console.log('1. upload-url:', r1.status, up.key ?? up);
  if (!r1.ok) return 1;

  // 2) Upload straight to S3/MinIO; our servers never see the bytes.
  const form = new FormData();
  for (const [k, v] of Object.entries(up.fields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type: contentType })); // must be last
  const r2 = await fetch(up.url, { method: 'POST', body: form });
  console.log(
    '2. S3 upload:',
    r2.status,
    r2.ok ? '' : (await r2.text()).match(/<Code>(.*?)<\/Code>/)?.[1],
  );
  if (!r2.ok) return 1;

  // 3) Confirm, so the API checks the stored file and attaches it.
  const r3 = await fetch(`${BASE}/v1/products/${productId}/images/confirm`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ key: up.key }),
  });
  const confirmed = await r3.json();
  console.log('3. confirm:', r3.status, confirmed.images ?? confirmed);
  return r3.ok ? 0 : 1;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
