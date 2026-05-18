exports.handler = async function handler(event, context) {
  const mod = await import("../../server/index.js");
  return mod.handler(event, context);
};
