// Renders an Obsidian-Excalidraw .md file to self-contained light + dark SVGs.
//
// Usage: node render.mjs <drawing.md> <embed-root-dir> <out-dir>
//
// The SVGs must work inside GitHub's README image proxy (camo), which renders
// them in an <img> sandbox that blocks ALL external fetches - fonts and
// embedded images are therefore inlined as data: URIs, and rendering runs
// fully offline: every fetch the excalidraw bundle attempts is served from
// the npm package on disk, anything else is refused. Element links and
// custom data are stripped so no vault-internal reference (obsidian:// URLs,
// note names) can end up in the published SVG, and the scene JSON itself is
// never embedded (exportEmbedScene stays off).

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, registerHooks } from "node:module";
import { JSDOM } from "jsdom";
import lzstring from "lz-string";

const [, , drawingPath, embedRoot, outDir] = process.argv;
if (!drawingPath || !embedRoot || !outDir) {
  console.error("Usage: node render.mjs <drawing.md> <embed-root-dir> <out-dir>");
  process.exit(2);
}

const require = createRequire(import.meta.url);
// resolves to dist/prod/index.js, whose directory also holds fonts/ etc.
const excalidrawDist = path.dirname(require.resolve("@excalidraw/excalidraw"));

// laser-pointer's `main` is parcel CJS whose named exports Node cannot
// detect; its sibling esm.js build is a real ES module - use that.
const laserPointerEsm = pathToFileURL(
  path.join(path.dirname(require.resolve("@excalidraw/laser-pointer")), "esm.js"),
).href;

// The excalidraw ESM bundle imports .json files without `with {type:"json"}`,
// which Node refuses - synthesize an ES module for such imports instead.
registerHooks({
  // It also uses bundler-style extensionless imports (e.g. "roughjs/bin/rough").
  resolve(specifier, context, nextResolve) {
    if (specifier === "@excalidraw/laser-pointer") {
      return { url: laserPointerEsm, shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (err?.code === "ERR_MODULE_NOT_FOUND" && !path.extname(specifier)) {
        try {
          return nextResolve(`${specifier}.js`, context);
        } catch {
          return nextResolve(`${specifier}/index.js`, context);
        }
      }
      throw err;
    }
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".json") && context.importAttributes?.type !== "json") {
      const data = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
      const named = Object.keys(data)
        .filter((k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k))
        .map((k) => `export const ${k} = data[${JSON.stringify(k)}];`)
        .join("\n");
      return {
        format: "module",
        source: `const data = ${JSON.stringify(data)};\n${named}\nexport default data;`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

// ---------------------------------------------------------------------------
// DOM shim + offline asset serving (must exist before the bundle is imported)
// ---------------------------------------------------------------------------

const ASSET_BASE = "https://excalidraw-assets.invalid/";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "https://localhost/",
  pretendToBeVisual: true,
});

for (const key of ["window", "document", "self"]) {
  Object.defineProperty(globalThis, key, {
    value: key === "document" ? dom.window.document : dom.window,
    configurable: true,
    writable: true,
  });
}
// Expose every window interface/constructor plus the browser singletons the
// bundle touches at module scope; never clobber Node's own globals.
const browserGlobals = Object.getOwnPropertyNames(dom.window).filter(
  (key) =>
    /^[A-Z]/.test(key) ||
    [
      "top",
      "parent",
      "location",
      "navigator",
      "getComputedStyle",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "devicePixelRatio",
      "localStorage",
      "sessionStorage",
      "innerWidth",
      "innerHeight",
    ].includes(key),
);
for (const key of browserGlobals) {
  if (!(key in globalThis)) {
    try {
      Object.defineProperty(globalThis, key, {
        get: () => dom.window[key],
        configurable: true,
      });
    } catch {
      // non-critical shim - skip anything jsdom refuses to hand out
    }
  }
}
// jsdom implements neither FontFace nor document.fonts; the exporter only
// needs them as metadata carriers while it fetches and inlines the woff2s.
class FontFaceShim {
  constructor(family, source, descriptors = {}) {
    this.family = family;
    this.source = source;
    Object.assign(this, descriptors);
    this.status = "unloaded";
  }
  async load() {
    this.status = "loaded";
    return this;
  }
}
dom.window.FontFace = FontFaceShim;
globalThis.FontFace = FontFaceShim;
const fontFaceSet = new Set();
fontFaceSet.ready = Promise.resolve(fontFaceSet);
fontFaceSet.check = () => false;
fontFaceSet.load = async () => [];
Object.defineProperty(dom.window.document, "fonts", { value: fontFaceSet, configurable: true });

if (!dom.window.matchMedia) {
  dom.window.matchMedia = () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
}
dom.window.EXCALIDRAW_ASSET_PATH = ASSET_BASE;

const MIME = {
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

globalThis.fetch = async (input) => {
  const url = String(typeof input === "object" && input?.url ? input.url : input);
  if (url.startsWith(ASSET_BASE)) {
    const rel = decodeURIComponent(url.slice(ASSET_BASE.length)).replace(/^\/+/, "");
    const file = path.join(excalidrawDist, path.normalize(rel));
    if (!file.startsWith(excalidrawDist + path.sep)) throw new Error(`Asset path escape: ${url}`);
    const body = await readFile(file);
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" },
    });
  }
  throw new Error(`Refusing network fetch during offline render: ${url}`);
};

// ---------------------------------------------------------------------------
// Parse the Obsidian-Excalidraw markdown container
// ---------------------------------------------------------------------------

const markdown = await readFile(drawingPath, "utf8");

const jsonBlock = markdown.match(/```compressed-json\r?\n([\s\S]*?)```/);
let sceneRaw;
if (jsonBlock) {
  sceneRaw = lzstring.decompressFromBase64(jsonBlock[1].replace(/\s+/g, ""));
  if (!sceneRaw) throw new Error("Failed to decompress the compressed-json drawing block");
} else {
  const plain = markdown.match(/```json\r?\n([\s\S]*?)```/);
  if (!plain) throw new Error("No drawing JSON block found in the markdown file");
  sceneRaw = plain[1];
}
const scene = JSON.parse(sceneRaw);

// `## Embedded Files` maps excalidraw fileIds to vault attachments; hydrate
// them from disk since the drawing JSON stores only the references.
const embeddedFiles = {};
const embedSection = markdown.match(/^## Embedded Files\r?\n([\s\S]*?)(?:^%%|^## )/m);
if (embedSection) {
  for (const line of embedSection[1].split(/\r?\n/)) {
    const entry = line.match(/^([0-9a-f]{40,}|[A-Za-z0-9_-]{8,}):\s*\[\[([^\]]+)\]\]/);
    if (!entry) continue;
    const [, fileId, target] = entry;
    const name = target.split("|")[0].split("#")[0].trim();
    embeddedFiles[fileId] = await resolveEmbed(name);
  }
}

async function resolveEmbed(name) {
  const wanted = path.basename(name).toLowerCase();
  const stack = [embedRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === wanted) return full;
    }
  }
  throw new Error(`Embedded file not found under ${embedRoot}: ${name}`);
}

const files = {};
for (const [fileId, filePath] of Object.entries(embeddedFiles)) {
  const mimeType = MIME[path.extname(filePath).toLowerCase()];
  if (!mimeType?.startsWith("image/")) throw new Error(`Unsupported embed type: ${filePath}`);
  files[fileId] = {
    id: fileId,
    mimeType,
    dataURL: `data:${mimeType};base64,${(await readFile(filePath)).toString("base64")}`,
    created: 0,
  };
}

// Strip anything that could reference vault internals; drop deleted elements
// so their text can't leak into the embedded font subset either.
const elements = (scene.elements ?? [])
  .filter((el) => !el.isDeleted)
  .map(({ link, customData, ...el }) => el);
if (elements.length === 0) throw new Error("Drawing contains no elements");

// ---------------------------------------------------------------------------
// Render, then express both themes as CSS
// ---------------------------------------------------------------------------
//
// Excalidraw's dark mode is purely an invert filter over otherwise identical
// geometry, so ONE render serves both themes: the filters are lifted off the
// elements and re-applied from a stylesheet instead.
//
// The two published files differ only in that stylesheet:
//   light - unconditionally light; the README's <picture> hands it out only
//           to light-scheme browsers.
//   dark  - dark by default, with a `prefers-color-scheme: light` override.
//           <picture> gives it only to dark-scheme browsers, where the
//           override cannot match, so the card renders dark as before. The
//           override exists for the README's click-through link: navigating
//           to this file directly then follows the reader's own theme.
//           Browsers that ignore media queries inside an <img>-loaded SVG
//           (Safari, as of WebKit bug 199134) simply keep the dark default.

const { exportToSvg } = await import("@excalidraw/excalidraw");

// The README's stat cards are the visual reference: #E4E2E2 border that
// renders 1px on screen, 4.5px corner radius, #ffffff / #2E3440 background.
const CARD = {
  borderColor: "#E4E2E2",
  radiusPx: 4.5,
  lightBg: "#ffffff",
  darkBg: "#2E3440",
  // Approximate README column width on desktop. The border thickness does
  // not depend on it (non-scaling stroke); it only sizes the corner radius
  // and inset in user units so they *display* at card proportions.
  displayWidth: 832,
};

const NS = "http://www.w3.org/2000/svg";
const IMAGE_USE_SELECTOR = 'use[href^="#image-"]';

// Render dark (so Excalidraw itself supplies the dark filter values rather
// than this script hardcoding them), then lift those filters into CSS: the
// drawing is wrapped in .infra-content, and the card background and border
// stay outside it so they never get color-inverted with the drawing.
function buildCard(svg) {
  const doc = svg.ownerDocument;
  const [, , width, height] = svg.getAttribute("viewBox").split(/\s+/).map(Number);
  const scale = width / CARD.displayWidth;
  const radius = CARD.radiusPx * scale;

  const contentFilter = svg.getAttribute("filter");
  if (!contentFilter) throw new Error("dark render produced no invert filter - upstream behavior changed");
  svg.removeAttribute("filter");

  const imageUses = [...svg.querySelectorAll(IMAGE_USE_SELECTOR)];
  const imageFilter = imageUses[0]?.getAttribute("filter") ?? null;
  for (const el of imageUses) el.removeAttribute("filter");

  // Every filter must be one this script knows how to re-apply from CSS;
  // anything else would silently lose its dark-mode treatment.
  const stray = [...svg.querySelectorAll("[filter]")];
  if (stray.length) {
    throw new Error(`unexpected filter on <${stray[0].tagName}> - cannot express theme in CSS`);
  }

  const content = doc.createElementNS(NS, "g");
  content.setAttribute("class", "infra-content");
  while (svg.firstChild) content.appendChild(svg.firstChild);

  const style = doc.createElementNS(NS, "style");
  svg.appendChild(style);

  const bg = doc.createElementNS(NS, "rect");
  bg.setAttribute("class", "infra-bg");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(width));
  bg.setAttribute("height", String(height));
  bg.setAttribute("rx", String(radius));
  svg.appendChild(bg);

  svg.appendChild(content);

  const inset = 0.5 * scale; // keep the on-screen half-pixel of stroke inside the viewBox
  const border = doc.createElementNS(NS, "rect");
  border.setAttribute("x", String(inset));
  border.setAttribute("y", String(inset));
  border.setAttribute("width", String(width - 2 * inset));
  border.setAttribute("height", String(height - 2 * inset));
  border.setAttribute("rx", String(radius));
  border.setAttribute("fill", "none");
  border.setAttribute("stroke", CARD.borderColor);
  border.setAttribute("stroke-width", "1");
  // renders 1 screen pixel no matter how far the SVG is scaled down,
  // matching the streak/activity cards
  border.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(border);

  return { style, contentFilter, imageFilter };
}

function themeCss(theme, contentFilter, imageFilter) {
  const light = [`.infra-bg{fill:${CARD.lightBg}}`, `.infra-content{filter:none}`];
  const dark = [`.infra-bg{fill:${CARD.darkBg}}`, `.infra-content{filter:${contentFilter}}`];
  if (imageFilter) {
    light.push(`.infra-content ${IMAGE_USE_SELECTOR}{filter:none}`);
    dark.push(`.infra-content ${IMAGE_USE_SELECTOR}{filter:${imageFilter}}`);
  }
  if (theme === "light") return light.join("");
  return `${dark.join("")}@media(prefers-color-scheme:light){${light.join("")}}`;
}

const svgRoot = await exportToSvg({
  elements,
  files,
  appState: {
    exportBackground: false,
    exportWithDarkMode: true,
    exportEmbedScene: false,
    exportScale: 1,
  },
  exportPadding: 128,
});
const { style, contentFilter, imageFilter } = buildCard(svgRoot);

function serialize() {
  const raw = new dom.window.XMLSerializer().serializeToString(svgRoot);
  // The exporter sets xmlns itself and the serializer re-declares it, which
  // produces a duplicate attribute - invalid XML that browsers refuse when
  // the SVG is loaded through <img>. Keep the first of each root attribute.
  return raw.replace(/^<svg\s([^>]*)>/, (_, attrs) => {
    const seen = new Set();
    const kept = [...attrs.matchAll(/([\w:-]+)="[^"]*"/g)]
      .filter(([, name]) => !seen.has(name) && seen.add(name))
      .map(([pair]) => pair);
    return `<svg ${kept.join(" ")}>`;
  });
}

// Both files come from the same DOM with only the stylesheet swapped, which
// guarantees their geometry is identical.
await mkdir(outDir, { recursive: true });
for (const theme of ["light", "dark"]) {
  style.textContent = themeCss(theme, contentFilter, imageFilter);
  const svg = serialize();
  validate(svg, theme);
  const outPath = path.join(outDir, `infrastructure-${theme}.svg`);
  await writeFile(outPath, svg, "utf8");
  console.log(`${outPath} OK (${Buffer.byteLength(svg)} bytes)`);
}

function validate(svg, theme) {
  const fail = (msg) => {
    throw new Error(`${theme} SVG failed validation: ${msg}`);
  };
  if (!svg.startsWith("<svg")) fail("output does not start with <svg");
  if (Buffer.byteLength(svg) < 20_000) fail("suspiciously small - render likely broke");
  if (svg.includes("obsidian://")) fail("contains an obsidian:// link");
  if (svg.includes("[[")) fail("contains a wiki-link");
  if (!svg.includes("@font-face")) fail("no embedded fonts");
  if (!svg.includes(CARD.borderColor)) fail("card border missing");
  if (!svg.includes(".infra-bg{fill:")) fail("theme stylesheet missing");
  if (theme === "dark" && !svg.includes("prefers-color-scheme:light")) {
    fail("dark file lacks the light-theme override the click-through relies on");
  }
  if (theme === "light" && svg.includes("prefers-color-scheme")) {
    fail("light file must be unconditionally light");
  }
  if (/url\(\s*["']?https?:/i.test(svg)) fail("font/style references an external URL");
  if (/href=["']https?:/i.test(svg)) fail("references an external resource");
  if (Object.keys(files).length > 0 && !svg.includes("data:image/")) fail("embedded image missing");
  // <img> loads SVG as strict XML - reject anything that does not parse.
  const parsed = new dom.window.DOMParser().parseFromString(svg, "image/svg+xml");
  const parseError = parsed.getElementsByTagName("parsererror")[0];
  if (parseError) fail(`not well-formed XML: ${parseError.textContent.slice(0, 200)}`);
}
