// Babel plugin for Jest only. Some ESM-only packages (e.g. @nestjs/typeorm)
// declare `const require = createRequire(import.meta.url)`. Once compiled to
// CommonJS that clashes with the module wrapper's own `require`, so rename it.
module.exports = () => ({
  visitor: {
    Program(path) {
      if (path.scope.hasOwnBinding('require')) {
        path.scope.rename('require', '_esmRequire');
      }
    },
  },
});
