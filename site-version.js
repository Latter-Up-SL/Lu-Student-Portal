(() => {
  const VERSION = "0.36.11";
  document.querySelectorAll("[data-site-version]").forEach(element => {
    element.textContent = `Version ${VERSION}`;
  });
})();