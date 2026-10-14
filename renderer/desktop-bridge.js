/* Adaptations spécifiques à la version bureau (Electron). */
(function () {
  // 1) alert()/confirm() : corrige la perte de focus des champs sous Windows.
  var nativeAlert = window.alert.bind(window);
  var nativeConfirm = window.confirm.bind(window);
  function fix() { try { if (window.desktop) window.desktop.focusFix(); } catch (e) {} }
  window.alert = function (m) { nativeAlert(m); fix(); };
  window.confirm = function (m) { var r = nativeConfirm(m); fix(); return r; };

  // 2) prompt() n'existe pas dans Electron : boîte de saisie du mot de passe intégrée.
  window.askPassword = function (message) {
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.className = 'modal';
      wrap.style.zIndex = '60';
      wrap.innerHTML =
        '<div class="modal-card" style="width:min(460px,100%)">' +
        '<h3 style="margin-top:0"></h3>' +
        '<div class="field"><input type="password" autocomplete="off"></div>' +
        '<div class="row" style="justify-content:flex-end;margin-top:12px">' +
        '<button class="btn ghost" data-a="cancel">Annuler</button>' +
        '<button class="btn" data-a="ok">Valider</button></div></div>';
      wrap.querySelector('h3').textContent = message;
      var input = wrap.querySelector('input');
      document.body.appendChild(wrap);
      setTimeout(function () { input.focus(); }, 30);

      function done(v) { wrap.remove(); resolve(v); }
      wrap.addEventListener('click', function (e) {
        var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
        if (a === 'ok') done(input.value);
        else if (a === 'cancel') done(null);
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') done(input.value);
        else if (e.key === 'Escape') done(null);
      });
    });
  };

  // 3) Version affichée sur l'écran de connexion.
  document.addEventListener('DOMContentLoaded', function () {
    if (window.desktop && window.desktop.getVersion) {
      window.desktop.getVersion().then(function (v) {
        var card = document.querySelector('.login-card');
        if (!card) return;
        var d = document.createElement('div');
        d.className = 'hint';
        d.style.textAlign = 'center';
        d.textContent = 'Application de bureau — version ' + v;
        card.appendChild(d);
      });
    }
  });
})();
