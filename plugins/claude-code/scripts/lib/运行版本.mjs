import fs from "node:fs";
export const BRIDGE_VERSION = JSON.parse(fs.readFileSync(new URL("../../.codex-plugin/plugin.json", import.meta.url), "utf8")).version;
