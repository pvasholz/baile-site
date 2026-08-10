// Baile site interactions — mobile nav toggle
(function () {
  function init() {
    var toggle = document.querySelector('.br-nav-toggle');
    var panel  = document.querySelector('.br-nav-mobile');
    if (!toggle || !panel) return;

    function setOpen(open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.classList.toggle('is-open', open);
      if (open) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    }

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = toggle.getAttribute('aria-expanded') !== 'true';
      setOpen(open);
    });

    // close on link tap
    panel.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });

    // close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });

    // close on outside tap
    document.addEventListener('click', function (e) {
      if (!panel.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });

    // close if viewport grows past breakpoint
    window.addEventListener('resize', function () {
      if (window.innerWidth > 900) setOpen(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
