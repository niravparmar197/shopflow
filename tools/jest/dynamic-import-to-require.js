// Babel plugin for Jest only. Jest can't run dynamic import() without
// --experimental-vm-modules; the MongoDB driver loads `os` that way, and
// under Jest it then sends an empty handshake ("Missing required sub-document
// 'driver'"). Rewrites import(x) to Promise.resolve().then(() => require(x)).
module.exports = ({ types: t }) => ({
  visitor: {
    CallExpression(path) {
      if (!t.isImport(path.node.callee)) return;
      const required = t.callExpression(t.identifier('require'), path.node.arguments);
      path.replaceWith(
        t.callExpression(
          t.memberExpression(
            t.callExpression(
              t.memberExpression(t.identifier('Promise'), t.identifier('resolve')),
              [],
            ),
            t.identifier('then'),
          ),
          [t.arrowFunctionExpression([], required)],
        ),
      );
    },
  },
});
