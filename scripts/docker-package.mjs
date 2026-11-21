#!/usr/bin/env node
/**
 * Build the all-in-one image for a target server and pack a deploy bundle.
 *
 * The bundle is one directory you copy to the server (scp/rsync/USB):
 *   agent-canvas-<tag>-<arch>.tar.gz   the image (`docker load -i` it)
 *   compose.yml, .env.example          deployment files
 *   DEPLOY.md                          the instructions
 *   SHA256SUMS                         integrity check
 *
 * Usage:
 *   node scripts/docker-package.mjs                        # linux/amd64
 *   node scripts/docker-package.mjs --platform linux/arm64
 *   node scripts/docker-package.mjs --tag agent-canvas:1.43.0 --out deploy-bundle
 *   node scripts/docker-package.mjs --skip-build           # pack an existing image
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  readFileSync(join(projectRoot, "config", "defaults.json"), "utf-8"),
);

const options = {
  platform: "linux/amd64",
  tag: `agent-canvas:${config.versions.agentCanvas}`,
  out: "deploy-bundle",
  skipBuild: false,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--platform") options.platform = argv[++i];
  else if (arg === "--tag") options.tag = argv[++i];
  else if (arg === "--out") options.out = argv[++i];
  else if (arg === "--skip-build") options.skipBuild = true;
  else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

const arch = options.platform.split("/")[1] ?? "unknown";
const outDir = join(projectRoot, options.out);
const safeTag = options.tag.replace(/[^a-zA-Z0-9._-]+/g, "-");
const imageFile = `${safeTag}-${arch}.tar.gz`;

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: projectRoot, stdio: "inherit" });
}

if (!options.skipBuild) {
  let gitSha = "unknown";
  try {
    gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot })
      .toString()
      .trim();
  } catch {
    // not a git checkout; keep "unknown"
  }
  run(process.execPath, [
    join("scripts", "docker-build.mjs"),
    "--tag",
    options.tag,
    "--",
    "--platform",
    options.platform,
    "--build-arg",
    `AGENT_CANVAS_VERSION=${config.versions.agentCanvas}`,
    "--build-arg",
    `OPENHANDS_BUILD_GIT_SHA=${gitSha}`,
  ]);
}

const imageArch = execFileSync("docker", [
  "image",
  "inspect",
  "-f",
  "{{.Architecture}}",
  options.tag,
])
  .toString()
  .trim();
if (imageArch !== arch) {
  console.error(
    `Image ${options.tag} is ${imageArch}, expected ${arch}. Rebuild without --skip-build.`,
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
console.log(
  `\nSaving ${options.tag} → ${join(options.out, imageFile)} (this takes a while)...`,
);
const save = spawn(
  "docker",
  ["save", "--platform", options.platform, options.tag],
  {
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const saved = new Promise((resolve, reject) => {
  save.on("error", reject);
  save.on("close", (code) =>
    code === 0 ? resolve() : reject(new Error(`docker save exited ${code}`)),
  );
});
await Promise.all([
  pipeline(
    save.stdout,
    createGzip({ level: 6 }),
    createWriteStream(join(outDir, imageFile)),
  ),
  saved,
]);

copyFileSync(
  join(projectRoot, "docker", "compose.yml"),
  join(outDir, "compose.yml"),
);
copyFileSync(
  join(projectRoot, "docker", ".env.example"),
  join(outDir, ".env.example"),
);
copyFileSync(join(projectRoot, "docs", "DEPLOY.md"), join(outDir, "DEPLOY.md"));
writeFileSync(join(outDir, "IMAGE"), `${options.tag}\n`);

const sums = [];
for (const file of [
  imageFile,
  "compose.yml",
  ".env.example",
  "DEPLOY.md",
  "IMAGE",
]) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(join(outDir, file)), hash);
  sums.push(`${hash.digest("hex")}  ${file}`);
}
writeFileSync(join(outDir, "SHA256SUMS"), `${sums.join("\n")}\n`);

console.log(
  `\nBundle ready in ${options.out}/ (image ${options.tag}, ${options.platform}).`,
);
console.log(`Copy it to the server, then follow ${options.out}/DEPLOY.md.`);
