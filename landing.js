/* ============================================================
   Asadiya Flotte PRO — Landing Page
   Tout le comportement vit ici (aucun script inline : CSP).
   ============================================================ */
(function () {
    'use strict';

    var root = document.documentElement;
    root.classList.remove('no-js');
    root.classList.add('js');

    /* ---- Année dynamique ---- */
    var yearEl = document.getElementById('year');
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    /* ---- Thème clair / sombre (préférence persistée) ---- */
    var THEME_KEY = 'afp-theme';
    var getStoredTheme = function () {
        try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
    };
    var applyTheme = function (theme) {
        if (theme !== 'light' && theme !== 'dark') theme = 'dark';
        root.setAttribute('data-theme', theme);
        try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* stockage indisponible */ }
    };
    applyTheme(getStoredTheme() || 'dark');

    var toggleTheme = function () {
        var current = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        applyTheme(current);
    };

    /* ---- Menu mobile ---- */
    var menuButton = document.querySelector('[data-action="toggle-menu"]');
    var mobileMenu = document.querySelector('[data-mobile-menu]');
    var setMenuOpen = function (open) {
        if (!mobileMenu || !menuButton) return;
        mobileMenu.classList.toggle('hidden', !open);
        var panel = mobileMenu.querySelector('.mobile-menu');
        if (panel) {
            panel.classList.toggle('open', open);
            panel.classList.toggle('closed', !open);
        }
        var icon = menuButton.querySelector('i');
        if (icon) {
            icon.classList.toggle('fa-bars', !open);
            icon.classList.toggle('fa-xmark', open);
        }
        menuButton.setAttribute('aria-expanded', String(open));
    };
    if (menuButton) {
        menuButton.addEventListener('click', function () {
            setMenuOpen(mobileMenu.classList.contains('hidden'));
        });
    }
    document.querySelectorAll('[data-close-menu]').forEach(function (link) {
        link.addEventListener('click', function () { setMenuOpen(false); });
    });

    /* ---- Délégation des actions (thème / menu) ---- */
    document.addEventListener('click', function (event) {
        var actionEl = event.target.closest('[data-action]');
        if (!actionEl) return;
        if (actionEl.dataset.action === 'toggle-theme') toggleTheme();
    });

    /* ---- Navbar : ombre au scroll ---- */
    var navbar = document.getElementById('navbar');
    var addNavShadow = function () {
        if (navbar) navbar.classList.toggle('nav-scrolled', window.scrollY > 8);
    };
    addNavShadow();
    window.addEventListener('scroll', addNavShadow, { passive: true });

    /* ---- Animations au scroll (IntersectionObserver) ---- */
    var revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (entry.isIntersecting) {
                entry.target.classList.add('in-view');
                revealObserver.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.reveal').forEach(function (el) {
        revealObserver.observe(el);
    });
})();
