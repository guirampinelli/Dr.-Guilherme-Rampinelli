(function () {
  "use strict";

  var consentKey = "drg_campaign_measurement_consent_v1";
  var attributionKey = "drguilherme_attribution_v3";
  var measurementSessionKey = "drg_measurement_session_v1";

  function readConsent() {
    try {
      return window.localStorage.getItem(consentKey);
    } catch (error) {
      return null;
    }
  }

  function saveConsent(value) {
    try {
      window.localStorage.setItem(consentKey, value);
    } catch (error) {
      // A escolha ainda vale durante a navegação atual.
    }
  }

  // Global Privacy Control: enquanto o sinal estiver ativo, a medição fica recusada,
  // mesmo que "Aceitar" tenha sido escolhido antes ou em outra aba.
  function gpcActive() {
    try {
      return window.navigator.globalPrivacyControl === true;
    } catch (error) {
      return false;
    }
  }

  function consentState() {
    return !gpcActive() && readConsent() === "accepted" ? "granted" : "denied";
  }

  function clearMeasurementData() {
    try {
      window.localStorage.removeItem(attributionKey);
    } catch (error) {
      // Nenhuma ação adicional é necessária.
    }
    try {
      window.sessionStorage.removeItem(measurementSessionKey);
    } catch (error) {
      // Nenhuma ação adicional é necessária.
    }
  }

  function dispatchChange() {
    document.dispatchEvent(new CustomEvent("drg:measurement-consent-change"));
  }

  function closeBanner() {
    var banner = document.querySelector("[data-cookie-consent]");
    if (banner) banner.remove();
  }

  function acceptMeasurement() {
    if (gpcActive()) return;
    saveConsent("accepted");
    window.__drMeasurementConsent = "granted";
    closeBanner();
    dispatchChange();
  }

  function rejectMeasurement() {
    saveConsent("rejected");
    window.__drMeasurementConsent = "denied";
    clearMeasurementData();
    closeBanner();
    dispatchChange();
  }

  function showBanner(force) {
    if (!force && readConsent()) return;
    if (document.querySelector("[data-cookie-consent]")) return;

    var gpc = gpcActive();
    var banner = document.createElement("aside");
    banner.className = "cookie-consent";
    banner.dataset.cookieConsent = "true";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-labelledby", "cookie-consent-title");
    banner.setAttribute("aria-describedby", "cookie-consent-description");
    banner.innerHTML =
      '<div class="cookie-consent-copy">' +
      '<strong id="cookie-consent-title">Privacidade e medição</strong>' +
      '<p id="cookie-consent-description">Com sua autorização, medimos as visitas à página de consulta e os cliques para agendar (medição interna: contagens, códigos de campanha e códigos resumidos da sessão e do clique para evitar duplicidade, guardados por até 30 dias). Ao clicar para agendar, o servidor também informa à Meta um evento de contato, com endereço IP, dados do navegador e, se você veio de um anúncio, o identificador do clique. Não enviamos sintomas, nome, telefone ou e-mail. Não usamos Google Analytics nem Meta Pixel. <a href="/privacidade/">Saiba mais</a>.</p>' +
      (gpc
        ? '<p data-cookie-gpc-notice>Seu navegador está enviando o sinal Global Privacy Control (GPC). Por isso a medição está recusada e não pode ser ativada aqui enquanto o sinal estiver ligado.</p>'
        : "") +
      "</div>" +
      '<div class="cookie-consent-actions">' +
      '<button type="button" class="cookie-button cookie-button-choice" data-cookie-reject>Recusar</button>' +
      '<button type="button" class="cookie-button cookie-button-choice" data-cookie-accept' +
      (gpc ? ' disabled aria-disabled="true" title="Indisponível com Global Privacy Control ativo"' : "") +
      ">Aceitar</button>" +
      "</div>";

    document.body.appendChild(banner);
    banner.querySelector("[data-cookie-accept]").addEventListener("click", acceptMeasurement);
    banner.querySelector("[data-cookie-reject]").addEventListener("click", rejectMeasurement);
  }

  var storedConsent = readConsent();
  if (gpcActive() && storedConsent !== "rejected") {
    // GPC prevalece sobre aceite anterior.
    storedConsent = "rejected";
    saveConsent(storedConsent);
  }
  window.__drMeasurementConsent = consentState();
  if (window.__drMeasurementConsent !== "granted") clearMeasurementData();

  // Escolha feita em outra aba: sincroniza o estado desta aba e, ao revogar,
  // apaga a sessão de medição e a atribuição.
  if (typeof window.addEventListener === "function") {
    window.addEventListener("storage", function (event) {
      if (event && event.key !== consentKey && event.key !== null) return;
      if (readConsent()) closeBanner();
      var next = consentState();
      if (next === window.__drMeasurementConsent) return;
      window.__drMeasurementConsent = next;
      if (next !== "granted") clearMeasurementData();
      dispatchChange();
    });
  }

  document.addEventListener("click", function (event) {
    var settingsButton =
      event.target && event.target.closest ? event.target.closest("[data-privacy-settings]") : null;
    if (!settingsButton) return;

    event.preventDefault();
    showBanner(true);
  });

  if (!storedConsent) showBanner(false);
})();
