// Generates TypeScript types + NestJS decorators from libs/proto/src/*.proto.
// Works on Windows and on the Linux CI runner.
const { execFileSync } = require('child_process');
const { mkdirSync, readdirSync } = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';
const bin = (name) =>
  path.resolve('node_modules/.bin', name + (isWin ? '.cmd' : ''));

const src = 'libs/proto/src';
const out = path.join(src, 'generated');
mkdirSync(out, { recursive: true });
const protos = readdirSync(src).filter((f) => f.endsWith('.proto'));

execFileSync(
  bin('protoc'),
  [
    `--plugin=protoc-gen-ts_proto=${bin('protoc-gen-ts_proto')}`,
    `--ts_proto_out=${out}`,
    // NestJS controller/client interfaces only. NestJS loads the .proto at
    // runtime and does the encoding, so no encode/decode code is generated.
    '--ts_proto_opt=nestJs=true,addGrpcMetadata=true,outputEncodeMethods=false,outputJsonMethods=false,outputClientImpl=false',
    `-I${src}`,
    ...protos.map((p) => path.join(src, p)),
  ],
  { stdio: 'inherit', shell: isWin },
);
console.log(`Proto types generated for ${protos.join(', ')}`);
