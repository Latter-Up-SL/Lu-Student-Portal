const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const output = path.join(root, "dist");
const excluded = new Set([
  ".git",
  "PLACEHOLDER",
  "supabase",
  "dist",
  "README.md",
  "netlify.toml",
  "netlify-build.cjs",
]);

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const name of fs.readdirSync(root)) {
  if (excluded.has(name)) continue;
  fs.cpSync(path.join(root, name), path.join(output, name), { recursive: true });
}

for (const name of ["index.html", "announcements.html", "videos.html", "photos.html", "schedule.html", "raffle.html", "admin.html"]) {
  const file = path.join(output, name);
  const html = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, html.replace(/<script\s+src=["']PLACEHOLDER\/preview\.js["']><\/script>/gi, ""));
}
