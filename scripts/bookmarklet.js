"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { minify } = require("terser");
const root = path.join(__dirname, "..");
(async function () {
  const readable = fs.readFileSync(path.join(root, "bookmarklet.js"), "utf8");
  const result = await minify(readable.replace(/^javascript:/, ""), { ecma: 2015 });
  const output = "javascript:" + result.code + "\n";
  const target = path.join(root, "bookmarklet.min.js");
  const readme = path.join(root, "README.md");
  const start = "<!-- bookmarklet:start -->", end = "<!-- bookmarklet:end -->";
  const body = start + "\n\nReadable bookmarklet:\n\n```javascript\n" + readable.trim() +
    "\n```\n\nCopy this entire single line into a bookmark's URL field:\n\n```javascript\n" + output.trim() + "\n```\n\n" + end;
  if (process.argv.includes("--check")) {
    if (fs.readFileSync(target, "utf8") !== output) throw new Error("Stale minified bookmarklet; run npm run build");
    if (!fs.readFileSync(readme, "utf8").includes(body)) throw new Error("Stale README bookmarklets; run npm run build");
  } else {
    fs.writeFileSync(target, output);
    if (fs.existsSync(readme)) {
      const text = fs.readFileSync(readme, "utf8");
      if (text.includes(start) && text.includes(end)) {
        fs.writeFileSync(readme, text.slice(0, text.indexOf(start)) + body + text.slice(text.indexOf(end) + end.length));
      }
    }
  }
})().catch(error => { process.exitCode = 1; console.error(error); });
