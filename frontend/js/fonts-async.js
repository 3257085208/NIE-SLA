(() => {
  // The Google Fonts stylesheet is loaded with media="print" so it never blocks
  // the first paint. The Pages CSP forbids inline handlers, so this small
  // external script flips the stylesheet to all media once it is ready.
  const FONT_LINK_SELECTOR = 'link[data-nie-sla-fonts][media="print"]';

  const activate = (link) => {
    if (link.media !== 'print') return;
    link.media = 'all';
  };

  const init = () => {
    document.querySelectorAll(FONT_LINK_SELECTOR).forEach((link) => {
      if (link.sheet) {
        activate(link);
        return;
      }
      link.addEventListener('load', () => activate(link));
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
