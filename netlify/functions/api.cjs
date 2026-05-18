const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

exports.handler = async function handler(event, context) {
  const candidates = [
    path.resolve(process.cwd(), "server", "index.js"),
    path.resolve(__dirname, "server", "index.js"),
    path.resolve(__dirname, "..", "server", "index.js")
  ];

  const serverEntryPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!serverEntryPath) {
    throw new Error(`Unable to locate bundled server entry. Checked: ${candidates.join(", ")}`);
  }

  const serverEntry = pathToFileURL(serverEntryPath).href;
  const mod = await import(serverEntry);
  return mod.handler(event, context);
};
