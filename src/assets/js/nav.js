// Archive "Show all / Show less" toggle.
(function () {
  const toggle = document.querySelector("[data-archive-toggle]");
  const list = document.querySelector("[data-archive-list]");
  if (!toggle || !list) return;
  let expanded = false;
  const more = toggle.dataset.moreLabel || "Show more";
  const less = toggle.dataset.lessLabel || "Show less";
  toggle.addEventListener("click", () => {
    expanded = !expanded;
    list.querySelectorAll(".archive-card.is-hidden, .archive-card.is-revealed").forEach((el) => {
      el.classList.toggle("is-revealed", expanded);
    });
    // Toggle the hidden state on every card past the initial count
    const initial = parseInt(list.dataset.initial, 10) || 10;
    const cards = list.querySelectorAll(".archive-card");
    cards.forEach((card, i) => {
      if (i >= initial) card.classList.toggle("is-hidden", !expanded);
    });
    toggle.textContent = expanded ? less : more;
    if (!expanded) toggle.scrollIntoView({ behavior: "smooth", block: "center" });
  });
})();

// Mobile nav toggle — minimal, no framework.
(function () {
  const toggle = document.querySelector(".nav-toggle");
  const nav = document.getElementById("primary-nav");
  if (!toggle || !nav) return;

  toggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    toggle.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
  });

  // Close menu if a link is tapped (avoids stuck-open state after navigation
  // on browsers that re-use the page from bfcache).
  nav.addEventListener("click", (e) => {
    if (e.target.closest("a") && nav.classList.contains("is-open")) {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Open menu");
    }
  });
})();
