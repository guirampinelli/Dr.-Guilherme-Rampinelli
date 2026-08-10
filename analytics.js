(function () {
  "use strict";

  var measurementId = "G-N3GMLBFNRH";
  var consentKey = "drg_analytics_consent_v1";
  var attributionKey = "drguilherme_attribution_v2";

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
      // A escolha ainda vale durante a navegação atual quando o armazenamento não está disponível.
    }
  }

  function dispatch(name) {
    document.dispatchEvent(new CustomEvent(name));
  }

  function ensureGoogleQueue() {
    window.dataLayer = window.dataLayer || [];
    window.gtag =
      window.gtag ||
      function () {
        window.dataLayer.push(arguments);
      };
  }

  function deniedConsent() {
    return {
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "denied"
    };
  }

  function loadAnalytics() {
    if (window.__drAnalyticsReady) return;

    ensureGoogleQueue();
    window.gtag("consent", "default", deniedConsent());
    window.gtag("consent", "update", {
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "granted"
    });
    window.gtag("set", "ads_data_redaction", true);
    window.gtag("js", new Date());
    window.gtag("config", measurementId, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    });

    var googleTag = document.createElement("script");
    googleTag.async = true;
    googleTag.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(measurementId);
    googleTag.dataset.googleAnalytics = measurementId;
    document.head.appendChild(googleTag);

    window.__drAnalyticsReady = true;
    dispatch("drg:analytics-ready");
  }

  function clearAnalyticsCookies() {
    document.cookie.split(";").forEach(function (cookie) {
      var name = cookie.split("=")[0].trim();
      if (name.indexOf("_ga") !== 0) return;

      document.cookie = name + "=; Max-Age=0; path=/; SameSite=Lax";
      document.cookie =
        name + "=; Max-Age=0; path=/; domain=." + window.location.hostname + "; SameSite=Lax";
    });
  }

  function closeBanner() {
    var banner = document.querySelector("[data-cookie-consent]");
    if (banner) banner.remove();
  }

  function acceptAnalytics() {
    saveConsent("accepted");
    window.__drAnalyticsConsent = "granted";
    closeBanner();
    loadAnalytics();
    dispatch("drg:consent-change");
  }

  function rejectAnalytics() {
    saveConsent("rejected");
    window.__drAnalyticsConsent = "denied";

    try {
      window.localStorage.removeItem(attributionKey);
    } catch (error) {
      // Nenhuma ação adicional é necessária.
    }

    if (typeof window.gtag === "function") {
      window.gtag("consent", "update", deniedConsent());
    }

    clearAnalyticsCookies();
    closeBanner();
    dispatch("drg:consent-change");
  }

  function showBanner(force) {
    if (!force && readConsent()) return;
    if (document.querySelector("[data-cookie-consent]")) return;

    var banner = document.createElement("aside");
    banner.className = "cookie-consent";
    banner.dataset.cookieConsent = "true";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-labelledby", "cookie-consent-title");
    banner.setAttribute("aria-describedby", "cookie-consent-description");
    banner.innerHTML =
      '<div class="cookie-consent-copy">' +
      '<strong id="cookie-consent-title">Privacidade e medição</strong>' +
      '<p id="cookie-consent-description">Com sua autorização, usamos o Google Analytics para entender visitas e melhorar o conteúdo. A análise é opcional e não usamos esses dados para publicidade personalizada. <a href="/privacidade/">Saiba mais</a>.</p>' +
      "</div>" +
      '<div class="cookie-consent-actions">' +
      '<button type="button" class="cookie-button cookie-button-secondary" data-cookie-reject>Recusar</button>' +
      '<button type="button" class="cookie-button cookie-button-primary" data-cookie-accept>Aceitar análise</button>' +
      "</div>";

    document.body.appendChild(banner);
    banner.querySelector("[data-cookie-accept]").addEventListener("click", acceptAnalytics);
    banner.querySelector("[data-cookie-reject]").addEventListener("click", rejectAnalytics);
    banner.querySelector("[data-cookie-accept]").focus();
  }

  var storedConsent = readConsent();
  window.__drAnalyticsConsent = storedConsent === "accepted" ? "granted" : "denied";
  window.__drAnalyticsReady = false;

  document.addEventListener("click", function (event) {
    var settingsButton =
      event.target && event.target.closest ? event.target.closest("[data-privacy-settings]") : null;
    if (!settingsButton) return;

    event.preventDefault();
    showBanner(true);
  });

  if (storedConsent === "accepted") {
    loadAnalytics();
  } else if (!storedConsent) {
    showBanner(false);
  }
})();
