import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const packageMetadata = JSON.parse(read("package.json"));
const version = packageMetadata.version;
const changelog = read("CHANGELOG.md");
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const releaseHeading = changelog.match(new RegExp(`^## \\[${escapedVersion}\\] - (\\d{4}-\\d{2}-\\d{2})$`, "m"));

if (!releaseHeading) {
  console.error(`版本不一致：CHANGELOG.md 缺少 v${version} 的日期条目`);
  process.exit(1);
}

const releaseDate = releaseHeading[1];

const checks = [
  ["docs/PROJECT_HANDOFF.md", `当前版本：v${version}`],
  ["docs/PROJECT_HANDOFF.md", `发布日期：${releaseDate}`],
  ["README.md", `当前稳定版本：**v${version}`],
  ["README.md", `（${releaseDate}）`],
  ["src/version.ts", 'import packageMetadata from "../package.json"'],
  ["backend/app/version.py", 'parents[2] / "package.json"'],
];

const failures = checks.filter(([relativePath, marker]) => !read(relativePath).includes(marker));
if (failures.length > 0) {
  for (const [relativePath, marker] of failures) {
    console.error(`版本不一致：${relativePath} 缺少 ${JSON.stringify(marker)}`);
  }
  process.exitCode = 1;
} else {
  console.log(`发布记录一致：v${version} (${releaseDate})`);
}
