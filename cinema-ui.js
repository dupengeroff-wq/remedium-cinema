/* Presentation and fullscreen only. Playback commands are owned by app.js. */
(() => {
  'use strict';
  const shell = document.getElementById('playerShell');
  if (!shell) return;
  const byId = id => document.getElementById(id);
  const controls = shell.querySelector('.controls');
  const icons = {
    play: '<path d="m9 5 11 7-11 7Z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    back: '<path d="M5 8H1.5V4.5M2 8a10 10 0 1 1-.3 7"/><text x="12" y="15.5" text-anchor="middle" stroke="none" fill="currentColor" font-family="Arial,sans-serif" font-size="9" font-weight="700">10</text>',
    forward: '<path d="M19 8h3.5V4.5M22 8a10 10 0 1 0 .3 7"/><text x="12" y="15.5" text-anchor="middle" stroke="none" fill="currentColor" font-family="Arial,sans-serif" font-size="9" font-weight="700">10</text>',
    sound: '<path d="m11 5-6 4H2v6h3l6 4V5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
    muted: '<path d="m11 5-6 4H2v6h3l6 4V5ZM16 9l6 6M22 9l-6 6"/>',
    full: '<path d="M9 3H3v6M15 3h6v6M21 15v6h-6M9 21H3v-6"/>',
    exit: '<path d="M3 9h6V3M21 9h-6V3M15 21v-6h6M9 21v-6H3"/>'
  };
  function icon(id, name, label) {
    const button = byId(id);
    if (!button) return;
    if (button.dataset.icon !== name || !button.firstElementChild) {
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
      button.dataset.icon = name;
    }
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  let playing = false;
  let hideTimer;
  let savedScroll = 0;
  let pending = false;
  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const active = () => fullscreenElement() === shell || shell.classList.contains('is-fallback');
  const reveal = () => {
    clearTimeout(hideTimer);
    shell.classList.remove('controls-hidden');
    if (active() && playing) hideTimer = setTimeout(() => {
      // Keep keyboard controls visible while a keyboard user is operating them.
      if (controls.contains(document.activeElement) && document.activeElement.matches(':focus-visible')) return;
      shell.classList.add('controls-hidden');
    }, 3000);
  };
  function refreshFullscreen() {
    const on = active();
    shell.classList.toggle('is-fullscreen', on);
    document.body.classList.toggle('cinema-open', on);
    icon('full', on ? 'exit' : 'full', on ? 'Выйти из полного экрана' : 'На весь экран');
    byId('full').setAttribute('aria-pressed', String(on));
    if (!on) {
      clearTimeout(hideTimer);
      shell.classList.remove('controls-hidden');
    } else reveal();
  }
  function fallback(on) {
    if (on) {
      // Keep the iframe attached: moving it can reload an embedded video.
      savedScroll = window.scrollY;
      shell.classList.add('is-fallback');
    } else {
      shell.classList.remove('is-fallback');
    }
    refreshFullscreen();
    if (!on) window.scrollTo(0, savedScroll);
  }
  async function toggleFullscreen() {
    if (pending) return;
    pending = true;
    try {
      if (shell.classList.contains('is-fallback')) {
        fallback(false);
      } else if (fullscreenElement()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
      } else {
        const request = shell.requestFullscreen || shell.webkitRequestFullscreen;
        if (request) {
          try {
            await request.call(shell);
            refreshFullscreen();
          } catch {
            fallback(true);
          }
        } else fallback(true);
      }
    } finally {
      pending = false;
    }
  }
  window.CinemaUI = {
    setPlaying(value) {
      const changed = playing !== !!value;
      playing = !!value;
      icon('play', playing ? 'pause' : 'play', playing ? 'Пауза' : 'Воспроизвести');
      byId('play').setAttribute('aria-pressed', String(playing));
      if (changed || !playing) reveal();
    },
    setMuted(value) {
      icon('sound', value ? 'muted' : 'sound', value ? 'Включить звук' : 'Выключить звук');
      byId('sound').setAttribute('aria-pressed', String(!!value));
    },
    refreshFullscreen,
    toggleFullscreen,
    reveal
  };
  icon('back', 'back', 'Назад на 10 секунд');
  icon('forward', 'forward', 'Вперёд на 10 секунд');
  window.CinemaUI.setPlaying(false);
  window.CinemaUI.setMuted(false);
  refreshFullscreen();
  byId('progress').setAttribute('aria-label', 'Позиция воспроизведения');
  byId('full').onclick = toggleFullscreen;
  const hotZone = document.createElement('div');
  hotZone.className = 'fullscreen-reveal';
  hotZone.setAttribute('aria-hidden', 'true');
  shell.append(hotZone);
  shell.addEventListener('pointermove', reveal, {passive: true});
  shell.addEventListener('pointerdown', reveal, {passive: true});
  shell.addEventListener('focusin', reveal);
  controls.addEventListener('pointerleave', reveal, {passive: true});
  document.addEventListener('fullscreenchange', refreshFullscreen);
  document.addEventListener('webkitfullscreenchange', refreshFullscreen);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && shell.classList.contains('is-fallback')) {
      event.preventDefault();
      fallback(false);
      byId('full').focus();
    }
    const target = event.target;
    const typing = target instanceof Element && target.closest('input,textarea,select,[contenteditable="true"]');
    if (!typing && !event.repeat && event.code === 'KeyF' && !event.ctrlKey && !event.metaKey && !event.altKey && byId('entry').classList.contains('hidden')) {
      event.preventDefault();
      toggleFullscreen();
    }
    if (active()) reveal();
  });
})();
