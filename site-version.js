(() => {
  const VERSION = "0.36.5";
  document.querySelectorAll("[data-site-version]").forEach(element => {
    element.textContent = `Version ${VERSION}`;
  });
})();
