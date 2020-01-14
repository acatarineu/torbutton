window.addEventListener("pageshow", function() {
  let evt = new CustomEvent("AboutTorLoad", { bubbles: true });
  document.dispatchEvent(evt);
});