import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isMainModule, reportFatalError } from "./process.js";

const MARKER = "// Local workaround: stream Windows ZIP extraction with tar.exe.";
const UNZIP_SIGNATURE = "export function unzip(zipFile, extractPath, desc, bar = true) {";

export function patchWindowsExtractor(source, version) {
  if (version !== "0.5.9") throw new Error("浏览器安装补丁仅适用于 Camoufox 0.5.9，请先检查新版解压实现");
  if (source.includes(MARKER)) return source;
  if (!source.includes(UNZIP_SIGNATURE) || !source.includes("const zip = new AdmZip(zipFile);")) {
    throw new Error("Camoufox 解压实现已变化，未应用补丁");
  }
  return source.replace(UNZIP_SIGNATURE, `${UNZIP_SIGNATURE}
    ${MARKER}
    if (process.platform === "win32" && typeof zipFile === "string") {
        const tar = path.join(process.env.SystemRoot || "C:/Windows", "System32", "tar.exe");
        fs.mkdirSync(extractPath, { recursive: true });
        rprint(desc || "Extracting with Windows tar.exe");
        execFileSync(tar, ["-xf", path.resolve(zipFile), "-C", path.resolve(extractPath)], {
            stdio: "inherit", windowsHide: true,
        });
        return;
    }`);
}

export async function installBrowser(args = process.argv.slice(2)) {
  const packageDirectory = dirname(dirname(fileURLToPath(import.meta.resolve("camoufox"))));
  if (process.platform === "win32") {
    const { version } = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
    const filename = join(packageDirectory, "dist", "pkgman.js");
    const source = await readFile(filename, "utf8");
    const patched = patchWindowsExtractor(source, version);
    if (source !== patched) await writeFile(filename, patched, "utf8");
  }
  const cli = join(packageDirectory, "dist", "__main__.js");
  const result = spawnSync(process.execPath, [cli, "fetch", ...args], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`浏览器安装失败（退出码 ${result.status}）`);
}

if (isMainModule(import.meta.url)) installBrowser().catch(reportFatalError);
