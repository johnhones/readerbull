document.addEventListener('DOMContentLoaded', function () {
  var toggle = document.querySelector('.mob-toggle');
  var panel = document.querySelector('.mob-panel');
  if (!toggle || !panel) return;

  toggle.addEventListener('click', function () {
    var isOpen = panel.classList.toggle('open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });
});
