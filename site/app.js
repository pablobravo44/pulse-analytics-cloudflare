(() => {
  const root = document.documentElement;

  const detectLang = () => {
    try {
      const saved = localStorage.getItem("pulse-site-lang");
      if (saved === "en" || saved === "es") return saved;
    } catch {}
    return navigator.language && navigator.language.toLowerCase().startsWith("es") ? "es" : "en";
  };

  const applyTheme = (theme) => {
    if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");
  };

  try {
    const savedTheme = localStorage.getItem("pulse-theme");
    if (savedTheme === "light" || savedTheme === "dark") applyTheme(savedTheme);
  } catch {}

  const applyLang = (lang) => {
    root.setAttribute("data-lang", lang);
    root.setAttribute("lang", lang);
    try {
      localStorage.setItem("pulse-site-lang", lang);
    } catch {}
    document.querySelectorAll("[data-set-lang]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-set-lang") === lang));
    });
    const filter = document.querySelector("[data-filter]");
    if (filter) {
      const ph = filter.getAttribute(lang === "es" ? "data-placeholder-es" : "data-placeholder-en");
      if (ph) {
        filter.setAttribute("placeholder", ph);
        filter.setAttribute("aria-label", ph);
      }
    }
  };

  applyLang(detectLang());

  const prefersDark = () => window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const currentTheme = () => root.getAttribute("data-theme") || (prefersDark() ? "dark" : "light");

  document.addEventListener("DOMContentLoaded", () => {
    applyLang(root.getAttribute("data-lang") || "en");

    document.querySelectorAll("[data-set-lang]").forEach((btn) => {
      btn.addEventListener("click", () => applyLang(btn.getAttribute("data-set-lang") || "en"));
    });

    const themeBtn = document.querySelector("[data-theme-toggle]");
    if (themeBtn) {
      themeBtn.addEventListener("click", () => {
        const next = currentTheme() === "dark" ? "light" : "dark";
        applyTheme(next);
        try {
          localStorage.setItem("pulse-theme", next);
        } catch {}
      });
    }

    // Copy buttons
    document.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const block = btn.closest(".code-block");
        const explicit = btn.getAttribute("data-copy-text");
        const pre = block ? block.querySelector("pre") : null;
        const text = explicit || (pre ? pre.textContent : "");
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text.trim());
          btn.classList.add("is-copied");
          const label = btn.querySelector("[data-copy-label]");
          const prev = label ? label.textContent : "";
          if (label) label.textContent = root.getAttribute("data-lang") === "es" ? "Copiado" : "Copied";
          setTimeout(() => {
            btn.classList.remove("is-copied");
            if (label) label.textContent = prev;
          }, 1500);
        } catch {}
      });
    });

    // Screenshot tour switcher
    const tourImg = document.querySelector("[data-tour-img]");
    const tourUrl = document.querySelector("[data-tour-url]");
    const tourCapEn = document.querySelector("[data-tour-cap-en]");
    const tourCapEs = document.querySelector("[data-tour-cap-es]");
    document.querySelectorAll("[data-tour-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll("[data-tour-tab]").forEach((t) => t.setAttribute("aria-selected", "false"));
        tab.setAttribute("aria-selected", "true");
        if (tourImg) {
          tourImg.setAttribute("src", tab.getAttribute("data-src") || "");
          tourImg.setAttribute("alt", tab.getAttribute("data-alt") || "");
        }
        if (tourUrl) tourUrl.textContent = tab.getAttribute("data-url") || "";
        if (tourCapEn) tourCapEn.textContent = tab.getAttribute("data-cap-en") || "";
        if (tourCapEs) tourCapEs.textContent = tab.getAttribute("data-cap-es") || "";
      });
    });

    // Install studio tabs
    document.querySelectorAll("[data-install-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.getAttribute("data-install-tab");
        document.querySelectorAll("[data-install-tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
        document.querySelectorAll("[data-install-panel]").forEach((p) => {
          p.hidden = p.getAttribute("data-install-panel") !== target;
        });
      });
    });

    // 12-color signal palette playground
    const preview = document.querySelector("[data-signal-preview]");
    const previewName = document.querySelector("[data-signal-name]");
    document.querySelectorAll("[data-swatch]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slot = btn.getAttribute("data-swatch");
        const label = btn.getAttribute("data-label");
        document.querySelectorAll("[data-swatch]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        if (preview && slot) preview.style.setProperty("--signal", `var(--${slot})`);
        if (previewName && label) previewName.textContent = label;
      });
    });

    // Docs mobile drawer
    const menuBtn = document.querySelector("[data-menu-toggle]");
    const backdrop = document.querySelector("[data-nav-backdrop]");
    const setNav = (open) => {
      document.body.classList.toggle("nav-open", open);
      if (menuBtn) menuBtn.setAttribute("aria-expanded", String(open));
    };
    if (menuBtn) menuBtn.addEventListener("click", () => setNav(!document.body.classList.contains("nav-open")));
    if (backdrop) backdrop.addEventListener("click", () => setNav(false));
    document.querySelectorAll(".docs-sidebar a").forEach((a) => a.addEventListener("click", () => setNav(false)));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setNav(false);
    });

    // Docs live filter
    const input = document.querySelector("[data-filter]");
    const statusEl = document.querySelector("[data-filter-status]");
    const statusText = document.querySelector("[data-filter-text]");
    const clearBtn = document.querySelector("[data-filter-clear]");
    if (input) {
      const items = [...document.querySelectorAll("[data-filter-item]")];
      const applyFilter = () => {
        const q = input.value.trim().toLowerCase();
        if (!q) {
          items.forEach((el) => el.classList.remove("is-filtered-out"));
          if (statusEl) statusEl.classList.remove("is-visible");
          return;
        }
        let shown = 0;
        items.forEach((el) => {
          const hit = (el.textContent || "").toLowerCase().includes(q);
          el.classList.toggle("is-filtered-out", !hit);
          if (hit) shown++;
        });
        if (statusEl && statusText) {
          statusEl.classList.add("is-visible");
          const es = root.getAttribute("data-lang") === "es";
          statusText.textContent = es
            ? `${shown} ${shown === 1 ? "sección" : "secciones"} para "${input.value.trim()}".`
            : `${shown} ${shown === 1 ? "section" : "sections"} matching "${input.value.trim()}".`;
        }
      };
      input.addEventListener("input", applyFilter);
      if (clearBtn) clearBtn.addEventListener("click", () => { input.value = ""; applyFilter(); input.focus(); });
      document.addEventListener("keydown", (e) => {
        if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const tag = document.activeElement && document.activeElement.tagName;
          if (tag !== "INPUT" && tag !== "TEXTAREA") {
            e.preventDefault();
            input.focus();
          }
        } else if (e.key === "Escape" && document.activeElement === input) {
          input.value = "";
          applyFilter();
          input.blur();
        }
      });
    }

    // Docs scroll-spy
    const headings = [...document.querySelectorAll(".docs-main h2[id]")];
    const tocLinks = [...document.querySelectorAll('.toc-rail a[href^="#"], .docs-sidebar a[href^="#"]')];
    if (headings.length && tocLinks.length && "IntersectionObserver" in window) {
      const byId = new Map();
      tocLinks.forEach((a) => {
        const id = (a.getAttribute("href") || "").slice(1);
        const list = byId.get(id) || [];
        list.push(a);
        byId.set(id, list);
      });
      let active = "";
      const setActive = (id) => {
        if (!id || id === active) return;
        active = id;
        tocLinks.forEach((a) => a.classList.remove("is-active"));
        (byId.get(id) || []).forEach((a) => a.classList.add("is-active"));
      };
      const io = new IntersectionObserver(
        (entries) => {
          const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          if (vis.length) setActive(vis[0].target.id);
        },
        { rootMargin: "-76px 0px -70% 0px", threshold: 0 },
      );
      headings.forEach((h) => io.observe(h));
      setActive(headings[0].id);
    }
  });
})();
