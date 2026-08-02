const target = document.getElementById("meta");

if (target && window.ascendDesktop) {
  target.textContent = `${window.ascendDesktop.appName} v${window.ascendDesktop.version}`;
}
