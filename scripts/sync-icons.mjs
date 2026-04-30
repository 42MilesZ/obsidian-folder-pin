import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_COLLECTION_URL =
  "https://www.iconfont.cn/collections/detail?cid=53082";
const DEFAULT_RENDERED_HTML_PATH = join(
  tmpdir(),
  "file-explorer-pin-iconfont-53082.html",
);
const FILE_TYPE_ICON_DIR = "assets/file-type-icons";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginRoot = resolve(__dirname, "..");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const html = await resolveHtml(options);
  const records = extractIcons(html, options.url);

  if (records.length === 0) {
    throw new Error("No icons were extracted from the rendered iconfont HTML.");
  }

  const outputDir = resolve(pluginRoot, options.outDir);
  await mkdir(outputDir, { recursive: true });

  const catalog = [];
  for (const record of records) {
    const safeName = toSafeName(record.originalName);
    const fileName = `${record.iconId}-${safeName}.svg`;
    const filePath = join(outputDir, fileName);

    await writeFile(filePath, `${sanitizeSvg(record.svg)}\n`, "utf8");
    catalog.push({
      iconId: record.iconId,
      originalName: record.originalName,
      canonicalName: record.originalName.toLowerCase(),
      fileName,
      sourceUrl: options.url,
    });
  }

  const catalogPath = join(outputDir, "catalog.json");
  await writeFile(`${catalogPath}`, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  console.log(`Generated ${catalog.length} SVG assets in ${outputDir}`);
}

function parseArgs(argv) {
  const options = {
    input: DEFAULT_RENDERED_HTML_PATH,
    outDir: FILE_TYPE_ICON_DIR,
    url: DEFAULT_COLLECTION_URL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--input" && next) {
      options.input = next;
      index += 1;
      continue;
    }
    if (arg === "--out-dir" && next) {
      options.outDir = next;
      index += 1;
      continue;
    }
    if (arg === "--url" && next) {
      options.url = next;
      index += 1;
      continue;
    }
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/sync-icons.mjs [--input rendered.html] [--url collectionUrl] [--out-dir assets/file-type-icons]

If --input does not exist, the script renders the collection URL with headless Chrome and extracts all SVGs from the resulting DOM.`);
}

async function resolveHtml(options) {
  if (options.input && existsSync(options.input)) {
    return readFile(options.input, "utf8");
  }

  const chromeBinary = findChromeBinary();
  if (!chromeBinary) {
    throw new Error(
      "Could not find a Chrome binary. Set FILE_EXPLORER_PIN_CHROME_BIN or pass --input with a rendered HTML file.",
    );
  }

  return execFileSync(
    chromeBinary,
    [
      "--headless=new",
      "--disable-gpu",
      "--virtual-time-budget=8000",
      "--dump-dom",
      options.url,
    ],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

function findChromeBinary() {
  const candidates = [
    process.env.FILE_EXPLORER_PIN_CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

function extractIcons(html, sourceUrl) {
  const icons = [];
  const pattern =
    /<li class="J_icon_id_(\d+)[^"]*"[\s\S]*?(<svg class="icon"[\s\S]*?<\/svg>)<\/div><span class="icon-name" title="([^"]+)"/g;

  for (const match of html.matchAll(pattern)) {
    const [, iconId, svg, originalName] = match;
    icons.push({
      iconId,
      svg,
      originalName,
      sourceUrl,
    });
  }

  return icons;
}

function sanitizeSvg(svg) {
  return svg
    .replace(/\s+p-id="[^"]*"/g, "")
    .replace(/\s+class="icon"/, "")
    .replace(/\s+style="[^"]*"/, "")
    .replace(/\s+version="[^"]*"/, "")
    .replace(/>\s+</g, "><")
    .trim();
}

function toSafeName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
