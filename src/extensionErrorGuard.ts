export const EXTENSION_ERROR_GUARD_SCRIPT = String.raw`
(() => {
  const extensionUrlPattern = /^(?:chrome|moz)-extension:\/\//;
  const comesFromExtension = (value, source) => {
    const stack = value && typeof value.stack === "string" ? value.stack : "";
    return extensionUrlPattern.test(typeof source === "string" ? source : "")
      || /(?:chrome|moz)-extension:\/\//.test(stack);
  };

  window.addEventListener("error", (event) => {
    if (comesFromExtension(event.error, event.filename)) event.stopImmediatePropagation();
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    if (comesFromExtension(event.reason, "")) event.stopImmediatePropagation();
  }, true);
})();
`;
