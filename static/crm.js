// The CRM's only client script: drag on the deal board, and the current tab
// kept in view on a narrow screen. Everything else is plain forms and htmx attributes.
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
  // On a phone the nav and a section's tabs scroll sideways; start each with
  // its current tab in view, as GitHub's and Gmail's do, not cut off at the edge.
  function showCurrent() {
    document.querySelectorAll("nav [aria-current=page]").forEach(function (a) {
      var row = a.parentElement;
      while (row && row !== document.body && row.scrollWidth <= row.clientWidth) row = row.parentElement;
      if (!row || row === document.body) return;
      var at = a.getBoundingClientRect(), box = row.getBoundingClientRect();
      row.scrollLeft += at.left + at.width / 2 - (box.left + box.width / 2);
    });
  }
  document.addEventListener("DOMContentLoaded", showCurrent);
  document.addEventListener("DOMContentLoaded", wire);
  document.addEventListener("htmx:afterSettle", wire);
})();
