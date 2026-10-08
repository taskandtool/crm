// The CRM's only client script: drag on the deal board, and a card that
// opens on a click. Everything else is plain forms and htmx attributes.
// A drop posts the same stage change the card's own select makes, and the
// server's answer (the whole pipeline) replaces the board, so a drop that
// fails leaves nothing pretending it worked. Without this file, or without
// JavaScript, each card's select and Save button do the same.
(function () {
  function wire() {
    if (!window.Sortable || !window.htmx) return;
    document.querySelectorAll("#pipeline [data-cards]").forEach(function (list) {
      if (list.dataset.sortable) return;
      list.dataset.sortable = "1";
      new Sortable(list, {
        group: "pipeline",
        sort: false,
        animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 120,
        draggable: "[data-deal-id]",
        // On a phone a swipe across a card scrolls the board; press and hold to drag.
        delay: 250,
        delayOnTouchOnly: true,
        // Pointer-driven rather than the browser's own drag, so a drag can
        // start on the title link and a drop never also opens the deal.
        forceFallback: true,
        fallbackTolerance: 4,
        filter: "button, input, select, option, label",
        preventOnFilter: false,
        onEnd: function (evt) {
          var stage = evt.to.dataset.stage;
          if (evt.from === evt.to || !stage) {
            if (evt.from !== evt.to) evt.from.appendChild(evt.item);
            return;
          }
          htmx.ajax("POST", "/deals/" + evt.item.dataset.dealId + "/stage", {
            target: "#pipeline",
            swap: "outerHTML",
            values: { stage: stage, return: "/deals" },
          });
        },
      });
    });
  }
  // A click anywhere on a card opens the deal, as its title does; the card's
  // stage select keeps its own click.
  document.addEventListener("click", function (e) {
    var card = e.target.closest && e.target.closest("#pipeline [data-deal-id]");
    if (!card || e.target.closest("a, button, input, select, label, form")) return;
    var link = card.querySelector("a[href]");
    if (link) link.click();
  });
  document.addEventListener("DOMContentLoaded", wire);
  document.addEventListener("htmx:afterSettle", wire);
})();
