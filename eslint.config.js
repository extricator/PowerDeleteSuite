module.exports = [{
  files: ["**/*.js"],
  ignores: ["node_modules/**", "powerdeletesuite.js", "bookmarklet.min.js"],
  languageOptions: {
    ecmaVersion: 2022, sourceType: "commonjs",
    globals: Object.fromEntries([
      "window", "document", "localStorage", "$", "alert", "confirm", "fetch", "URLSearchParams",
      "AbortController", "setTimeout", "clearTimeout", "console", "createRedditScheduler", "process", "__dirname", "URL", "Headers",
    ].map(key => [key, "readonly"])),
  },
  rules: { "no-undef": "error", "no-unreachable": "error", "no-dupe-keys": "error",
    "no-constant-condition": "error", "constructor-super": "error", "valid-typeof": "error" },
}];
