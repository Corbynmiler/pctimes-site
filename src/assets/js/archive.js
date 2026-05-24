// Show-more toggle for the previous-issues archive on /latest-issue/.
(function () {
  const list = document.querySelector("[data-archive-list]");
  const toggle = document.querySelector("[data-archive-toggle]");
  if (!list || !toggle) return;

  const initial = parseInt(list.dataset.initial, 10) || 10;
  const cards = list.querySelectorAll(".archive-card");
  const moreLabel = toggle.dataset.moreLabel || toggle.textContent.trim();
  const lessLabel = toggle.dataset.lessLabel || "Show less";
  let expanded = false;

  toggle.addEventListener("click", () => {
    expanded = !expanded;
    cards.forEach((card, i) => {
      if (i >= initial) card.classList.toggle("is-hidden", !expanded);
    });
    toggle.textContent = expanded ? lessLabel : moreLabel;
    if (!expanded) {
      // Scroll back to the top of the archive section so the page doesn't
      // dump the user 6 screens below where they were.
      const heading = list.previousElementSibling;
      if (heading && heading.scrollIntoView) heading.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
})();
