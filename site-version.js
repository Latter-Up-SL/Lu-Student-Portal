(() => {
  const VERSION = "0.36.9";
  document.querySelectorAll("[data-site-version]").forEach(element => {
    element.textContent = `Version ${VERSION}`;
  });
})();