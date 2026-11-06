import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function isMainModule(moduleUrl) {
  return Boolean(process.argv[1]) && moduleUrl === pathToFileURL(resolve(process.argv[1])).href;
}

export function reportFatalError(error) {
  console.error(error.message);
  process.exitCode = 1;
}
