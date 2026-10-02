// The CRM's only client script: drag on the pipeline. Everything else is
// plain forms and htmx attributes. A drop posts the same stage change the
// card's own select makes, and the server's answer (the whole pipeline)
// replaces the board, so a drop that fails leaves nothing pretending it
// worked. Without this file, or without JavaScript, each card's select and
// Save button do the same.
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
        draggable: "[data-customer-id]",
        // On a phone a swipe across a card scrolls the board; press and hold to drag.
        delay: 250,
        delayOnTouchOnly: true,
        filter: "a, button, input, select, option, label",
        preventOnFilter: false,
        onEnd: function (evt) {
          var stage = evt.to.dataset.stage;
          if (evt.from === evt.to || !stage) {
            if (evt.from !== evt.to) evt.from.appendChild(evt.item);
            return;
          }
          htmx.ajax("POST", "/customers/" + evt.item.dataset.customerId + "/stage", {
            target: "#pipeline",
            swap: "outerHTML",
            values: { stage: stage, return: "/pipeline" },
          });
        },
      });
    });
  }
  document.addEventListener("DOMContentLoaded", wire);
  document.addEventListener("htmx:afterSettle", wire);
})();
