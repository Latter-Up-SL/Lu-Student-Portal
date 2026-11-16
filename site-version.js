(() => {
  const VERSION = "0.9.3";
  document.querySelectorAll("[data-site-version]").forEach(element => {
    element.textContent = `Version ${VERSION}`;
  });
})();