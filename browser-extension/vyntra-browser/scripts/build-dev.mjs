// Genera una copia de la extension con manifest.dev.json como manifest.json
// (acepta la estacion en http://localhost:3000 y :3001) para cargarla con
// "Load unpacked". El manifest de produccion no incluye localhost.
//
// Uso: node browser-extension/vyntra-browser/scripts/build-dev.mjs [carpeta_destino]
// Destino por defecto: <tmp>/vyntra-browser-dev
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(process.argv[2] || join(tmpdir(), "vyntra-browser-dev"));
const files = ["background.js", "content-script.js", "popup.css", "popup.html", "popup.js", "README.md"];

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of files) copyFileSync(join(root, file), join(target, file));
copyFileSync(join(root, "manifest.dev.json"), join(target, "manifest.json"));
console.log(`Extension de desarrollo lista en: ${target}`);
