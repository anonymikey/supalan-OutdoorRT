(function () {
  'use strict';

  var deferredPrompt = null;
  var banner;
  var bannerCopy;
  var installButton;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function isInstallPage() {
    return document.body && (
      document.body.getAttribute('data-supa-lan-home') === 'true' ||
      document.body.getAttribute('data-supa-lan-portal') === 'true'
    );
  }

  function getInstallInstructions() {
    var isAppleMobile = /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
      (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
    return isAppleMobile
      ? 'To install, tap Share in your browser, then choose “Add to Home Screen.”'
      : 'To install, open your browser menu and choose “Install app” or “Add to Home screen.”';
  }

  function createBanner() {
    banner = document.createElement('aside');
    banner.id = 'supa-lan-install-banner';
    banner.setAttribute('aria-label', 'Install SUPA LAN');
    banner.innerHTML = '<img class="supa-lan-install-icon" src="/icons/supalan-192.png" alt="SUPA LAN">' +
      '<span class="supa-lan-install-copy" role="status" aria-live="polite">Save this portal to your home screen for quick access.</span>' +
      '<button class="supa-lan-install-button" type="button">How to install</button>';
    document.body.prepend(banner);

    bannerCopy = banner.querySelector('.supa-lan-install-copy');
    installButton = banner.querySelector('.supa-lan-install-button');
    installButton.addEventListener('click', async function () {
      if (isStandalone()) {
        banner.hidden = true;
        return;
      }

      if (!deferredPrompt) {
        bannerCopy.textContent = getInstallInstructions();
        return;
      }

      var promptEvent = deferredPrompt;
      deferredPrompt = null;
      installButton.disabled = true;
      installButton.textContent = 'Waiting…';
      try {
        await promptEvent.prompt();
        var choice = await promptEvent.userChoice;
        if (choice.outcome === 'accepted') {
          bannerCopy.textContent = 'Follow the browser prompt to finish installing SUPA LAN.';
          installButton.textContent = 'Installing…';
        } else {
          bannerCopy.textContent = 'No problem. You can install later from your browser menu.';
          installButton.textContent = 'How to install';
        }
      } catch (error) {
        bannerCopy.textContent = getInstallInstructions();
        installButton.textContent = 'How to install';
      } finally {
        installButton.disabled = false;
      }
    });

    return banner;
  }

  function hideWhenInstalled() {
    if (isStandalone() && banner) banner.hidden = true;
  }

  function start() {
    if (!isInstallPage()) return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
    }
    if (isStandalone()) return;

    createBanner();
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      if (isStandalone()) return;
      deferredPrompt = event;
      bannerCopy.textContent = 'Install SUPA LAN for quick access to your subscription.';
      installButton.textContent = 'Install';
      banner.hidden = false;
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      if (banner) banner.hidden = true;
    });
    var displayMode = window.matchMedia('(display-mode: standalone)');
    if (displayMode.addEventListener) displayMode.addEventListener('change', hideWhenInstalled);
    else if (displayMode.addListener) displayMode.addListener(hideWhenInstalled);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
}());
