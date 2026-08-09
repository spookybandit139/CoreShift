(() => {
  'use strict';
  const root = document.documentElement;
  const progress = document.getElementById('readingProgress');
  const themeButton = document.getElementById('themeButton');
  const printButton = document.getElementById('printButton');
  const search = document.getElementById('sectionSearch');
  const status = document.getElementById('searchStatus');
  const sections = [...document.querySelectorAll('.terms-document section')];
  const tocLinks = [...document.querySelectorAll('#toc a')];
  const savedTheme = localStorage.getItem('coreshift-legal-theme');
  if (savedTheme === 'violet') root.dataset.theme = 'violet';
  themeButton.addEventListener('click', () => {
    const next = root.dataset.theme === 'violet' ? '' : 'violet';
    if (next) root.dataset.theme = next;
    else delete root.dataset.theme;
    localStorage.setItem('coreshift-legal-theme', next);
  });
  printButton.addEventListener('click', () => window.print());
  const updateProgress = () => {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const percent = scrollable > 0 ? Math.min(100, Math.max(0, window.scrollY / scrollable * 100)) : 0;
    progress.style.width = percent + '%';
  };
  updateProgress();
  window.addEventListener('scroll', updateProgress, { passive: true });
  window.addEventListener('resize', updateProgress);
  const normalize = value => value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  search.addEventListener('input', () => {
    const query = normalize(search.value);
    let matches = 0;
    sections.forEach(section => {
      const haystack = normalize(section.textContent + ' ' + (section.dataset.search || ''));
      const visible = !query || haystack.includes(query);
      section.classList.toggle('hidden', !visible);
      if (visible) matches += 1;
    });
    status.textContent = query ? matches + (matches === 1 ? ' section found' : ' sections found') : '';
  });
  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    tocLinks.forEach(link => link.classList.toggle('active', link.hash === '#' + visible.target.id));
  }, { rootMargin: '-18% 0px -67% 0px', threshold: [0, .15, .5] });
  sections.forEach(section => observer.observe(section));
})();
